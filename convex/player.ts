import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { deviceStatus, playbackStatus, slotState } from "./schema";
import { recordAudit } from "./lib/audit";
import { computeScreenPrice } from "./lib/screenPrice";
import { creativeReady, onMomentFirstFrame } from "./lib/momentHooks";

const CURRENT_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const NEXT_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
const HOUSE_AD_WINDOW_MS = 12 * 60 * 60 * 1000;
const HOUSE_AD_MAX_SLOTS = 48;
/** Playback reports must fall within [startAt - 5 min, endAt + 30 min]. */
const PLAYBACK_EARLY_MS = 5 * 60 * 1000;
const PLAYBACK_LATE_MS = 30 * 60 * 1000;

const slotView = v.object({
  slotId: v.id("slots"),
  startAt: v.number(),
  endAt: v.number(),
  state: slotState,
  bookingId: v.optional(v.id("bookings")),
  campaignId: v.optional(v.id("campaigns")),
  advertiserName: v.optional(v.string()),
  /** Present only when the slot is scheduled/played with an approved creative. */
  creativeUrl: v.optional(v.string()),
  contentType: v.optional(v.string()),
});

async function toSlotView(ctx: QueryCtx, slot: Doc<"slots">) {
  const view: {
    slotId: Id<"slots">;
    startAt: number;
    endAt: number;
    state: Doc<"slots">["state"];
    bookingId?: Id<"bookings">;
    campaignId?: Id<"campaigns">;
    advertiserName?: string;
    creativeUrl?: string;
    contentType?: string;
  } = { slotId: slot._id, startAt: slot.startAt, endAt: slot.endAt, state: slot.state };
  if (!slot.bookingId) return view;
  const booking = await ctx.db.get(slot.bookingId);
  if (!booking) return view;
  view.bookingId = booking._id;
  view.campaignId = booking.campaignId;
  const campaign = await ctx.db.get(booking.campaignId);
  if (!campaign) return view;
  const advertiser = await ctx.db.get(campaign.advertiserId);
  if (advertiser) view.advertiserName = advertiser.displayName;
  const playable = slot.state === "scheduled" || slot.state === "played";
  if (playable && campaign.creativeStorageId && (await creativeReady(ctx, campaign, slot.workspaceId))) {
    const url = await ctx.storage.getUrl(campaign.creativeStorageId);
    if (url) {
      view.creativeUrl = url;
      view.contentType = campaign.creativeContentType;
    }
  }
  return view;
}

/**
 * What the screen should show at `atMinute` (client passes Date.now() floored
 * to the minute, so the subscription changes every minute). The query never
 * reads the clock itself. Throws ConvexError NOT_FOUND for an unknown billboard.
 */
export const nowPlaying = query({
  args: { billboardId: v.id("billboards"), atMinute: v.number() },
  returns: v.object({
    billboard: v.object({ name: v.string(), city: v.string(), deviceStatus }),
    current: v.union(v.null(), slotView),
    next: v.union(v.null(), slotView),
    houseAd: v.object({
      /** Price-free tagline; render fromPriceMinor separately. */
      message: v.string(),
      /** Cheapest available slot in the next 12h; null if sold out. */
      fromPriceMinor: v.union(v.number(), v.null()),
    }),
  }),
  handler: async (ctx, args) => {
    const at = args.atMinute;
    if (!Number.isFinite(at) || at <= 0) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "atMinute must be a timestamp (ms)" });
    }
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    }

    const latestStarted = await ctx.db
      .query("slots")
      .withIndex("by_billboard_and_startAt", (q) =>
        q
          .eq("billboardId", billboard._id)
          .gt("startAt", at - CURRENT_LOOKBACK_MS)
          .lte("startAt", at),
      )
      .order("desc")
      .first();
    const current =
      latestStarted && latestStarted.endAt > at ? await toSlotView(ctx, latestStarted) : null;

    const nextSlot = await ctx.db
      .query("slots")
      .withIndex("by_billboard_and_startAt", (q) =>
        q
          .eq("billboardId", billboard._id)
          .gt("startAt", at)
          .lte("startAt", at + NEXT_LOOKAHEAD_MS),
      )
      .first();
    const next = nextSlot ? await toSlotView(ctx, nextSlot) : null;

    // House ad: cheapest available upcoming slot, priced by the same policy as quotes.
    const upcoming = await ctx.db
      .query("slots")
      .withIndex("by_billboard_and_startAt", (q) =>
        q
          .eq("billboardId", billboard._id)
          .gt("startAt", at)
          .lte("startAt", at + HOUSE_AD_WINDOW_MS),
      )
      .take(HOUSE_AD_MAX_SLOTS);
    const available = upcoming.filter((s) => s.state === "available");
    let fromPriceMinor: number | null = null;
    if (available.length > 0) {
      // Same screen-price harness as quotes (all stages), priced in one pass.
      const { price } = await computeScreenPrice(ctx.db, billboard, available, at);
      fromPriceMinor = Math.min(...price.slotPrices.map((p) => p.amountMinor));
    }
    const message =
      fromPriceMinor === null
        ? `${billboard.name} is fully booked for the next 12 hours.`
        : `Book 15 minutes on ${billboard.name} with BillboardOS.`;

    return {
      billboard: {
        name: billboard.name,
        city: billboard.city,
        deviceStatus: billboard.deviceStatus,
      },
      current,
      next,
      houseAd: { message, fromPriceMinor },
    };
  },
});

/**
 * Device playback receipt (P0-08). Idempotent per slotId+status: a repeat
 * report returns the original event. Only `scheduled` slots (approved
 * creative) can be reported. This is a delivery receipt, not measured reach.
 * TODO(auth): unauthenticated for the demo; require a per-device secret before
 * anything public (same as audience.record).
 */
export const recordPlayback = mutation({
  args: {
    slotId: v.id("slots"),
    bookingId: v.id("bookings"),
    status: playbackStatus,
  },
  returns: v.object({
    playbackEventId: v.id("playbackEvents"),
    slotState,
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("playbackEvents")
      .withIndex("by_slot_and_status", (q) =>
        q.eq("slotId", args.slotId).eq("status", args.status),
      )
      .first();
    if (existing) {
      const slot = await ctx.db.get(args.slotId);
      return {
        playbackEventId: existing._id,
        slotState: slot?.state ?? (args.status === "played" ? "played" : "failed_delivery"),
        replayed: true,
      };
    }

    const slot = await ctx.db.get(args.slotId);
    if (!slot) throw new ConvexError({ code: "NOT_FOUND", message: "Slot not found" });
    if (slot.bookingId !== args.bookingId) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Slot is not part of this booking" });
    }
    if (slot.state !== "scheduled") {
      throw new ConvexError({
        code: "NOT_SCHEDULED",
        message: `Slot is ${slot.state}; only scheduled slots (approved creative) can report playback`,
      });
    }
    const now = Date.now();
    if (now < slot.startAt - PLAYBACK_EARLY_MS || now > slot.endAt + PLAYBACK_LATE_MS) {
      throw new ConvexError({
        code: "OUTSIDE_SLOT_WINDOW",
        message: "Playback report is outside the slot's time window",
      });
    }
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new ConvexError({ code: "NOT_FOUND", message: "Booking not found" });
    const campaign = await ctx.db.get(booking.campaignId);

    const playbackEventId = await ctx.db.insert("playbackEvents", {
      workspaceId: slot.workspaceId,
      bookingId: booking._id,
      slotId: slot._id,
      billboardId: slot.billboardId,
      campaignId: booking.campaignId,
      storageId: campaign?.creativeStorageId,
      contentType: campaign?.creativeContentType,
      observedAt: now,
      status: args.status,
    });
    const newState = args.status === "played" ? ("played" as const) : ("failed_delivery" as const);
    await ctx.db.patch(slot._id, { state: newState });

    // Roll the booking forward once none of its slots are still pending.
    const states: string[] = [];
    for (const id of booking.slotIds) {
      states.push(id === slot._id ? newState : ((await ctx.db.get(id))?.state ?? "missing"));
    }
    const pending = states.some((s) => s === "booked" || s === "scheduled");
    if (!pending) {
      const allPlayed = states.every((s) => s === "played");
      await ctx.db.patch(booking._id, { status: allPlayed ? "played" : "failed" });
    }

    const storageSha = campaign?.creativeStorageId
      ? ((await ctx.db.system.get(campaign.creativeStorageId))?.sha256 ?? null)
      : null;
    await recordAudit(ctx, {
      workspaceId: booking.workspaceId,
      traceId: booking.traceId,
      actor: "device",
      type: args.status === "played" ? "playback.observed" : "playback.failed",
      subjectId: playbackEventId,
      reason:
        args.status === "played"
          ? "Device reported creative played (delivery receipt, not audience reach)"
          : "Device reported delivery failure",
      data: {
        slotId: slot._id,
        bookingId: booking._id,
        billboardId: slot.billboardId,
        observedAt: now,
        assetSha256: storageSha,
      },
    });

    // Live moment (ADR 0006): first frame stops the stopwatch.
    if (args.status === "played") await onMomentFirstFrame(ctx, booking._id, now);

    return { playbackEventId, slotState: newState, replayed: false };
  },
});

/**
 * Creatives ready to play on this screen (approved for its host): the player
 * preloads them so a flash spot starts instantly (ADR 0006). URLs only.
 */
export const readyCreatives = query({
  args: { billboardId: v.id("billboards") },
  returns: v.array(v.object({ campaignId: v.id("campaigns"), url: v.string(), contentType: v.union(v.string(), v.null()) })),
  handler: async (ctx, args) => {
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard?.workspaceId) return [];
    const workspaceId = billboard.workspaceId;
    const approvals = await ctx.db
      .query("creativeApprovals")
      .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId))
      .take(12);
    const out = [];
    for (const a of approvals) {
      const campaign = await ctx.db.get(a.campaignId);
      if (!campaign?.creativeStorageId || campaign.status !== "active") continue;
      const url = await ctx.storage.getUrl(campaign.creativeStorageId);
      if (url) out.push({ campaignId: campaign._id, url, contentType: campaign.creativeContentType ?? null });
    }
    return out;
  },
});
