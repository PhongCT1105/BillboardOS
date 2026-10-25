import { ConvexError, v, type Infer } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { deviceStatus, playbackStatus, slotState } from "./schema";
import { recordAudit } from "./lib/audit";
import { YOUTUBE_CONTENT_TYPE, hasCreative } from "./lib/youtube";
import { explorerTxUrl } from "./lib/x402/money";

const CURRENT_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const NEXT_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
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
  /** YouTube creative (contentType "youtube"): play it with the official embed. */
  youtubeVideoId: v.optional(v.string()),
  creativeTitle: v.optional(v.string()),
});

/**
 * A campaign's creative can play on this host's screens: approved
 * platform-wide or by this host. Same rule as momentHooks.creativeReady,
 * plus YouTube creatives (which have no storage file).
 */
async function creativePlayable(ctx: QueryCtx, campaign: Doc<"campaigns">, workspaceId: Id<"workspaces"> | undefined) {
  if (!hasCreative(campaign)) return false;
  if (campaign.creativeStatus === "approved") return true;
  if (!workspaceId) return false;
  const approval = await ctx.db
    .query("creativeApprovals")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId).eq("campaignId", campaign._id))
    .first();
  return approval !== null;
}

async function youtubeOf(ctx: QueryCtx, campaignId: Id<"campaigns">) {
  return await ctx.db
    .query("youtubeCreatives")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .unique();
}

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
    youtubeVideoId?: string;
    creativeTitle?: string;
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
  if (playable && (await creativePlayable(ctx, campaign, slot.workspaceId))) {
    if (campaign.creativeContentType === YOUTUBE_CONTENT_TYPE) {
      const yt = await youtubeOf(ctx, campaign._id);
      if (yt) {
        view.creativeUrl = yt.url;
        view.contentType = YOUTUBE_CONTENT_TYPE;
        view.youtubeVideoId = yt.videoId;
        if (yt.title) view.creativeTitle = yt.title;
      }
    } else if (campaign.creativeStorageId) {
      const url = await ctx.storage.getUrl(campaign.creativeStorageId);
      if (url) {
        view.creativeUrl = url;
        view.contentType = campaign.creativeContentType;
      }
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
    houseAd: v.object({ message: v.string() }),
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

    // House ad: agents buy the spot on air; there is no posted price.
    const message = `Advertise on ${billboard.name} with BillboardOS.`;

    return {
      billboard: {
        name: billboard.name,
        city: billboard.city,
        deviceStatus: billboard.deviceStatus,
      },
      current,
      next,
      houseAd: { message },
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


    return { playbackEventId, slotState: newState, replayed: false };
  },
});

/**
 * Creatives ready to play on this screen (approved for its host): the player
 * preloads them so a flash spot starts instantly (ADR 0006). URLs only.
 */
export const readyCreatives = query({
  args: { billboardId: v.id("billboards") },
  returns: v.array(
    v.object({
      campaignId: v.id("campaigns"),
      /** File URL, or the thumbnail for a YouTube creative (warmed, not the video). */
      url: v.string(),
      contentType: v.union(v.string(), v.null()),
      youtubeVideoId: v.optional(v.string()),
    }),
  ),
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
      if (!campaign || !hasCreative(campaign) || campaign.status !== "active") continue;
      if (campaign.creativeContentType === YOUTUBE_CONTENT_TYPE) {
        const yt = await youtubeOf(ctx, campaign._id);
        if (yt) out.push({ campaignId: campaign._id, url: yt.thumbnailUrl, contentType: YOUTUBE_CONTENT_TYPE, youtubeVideoId: yt.videoId });
        continue;
      }
      if (!campaign.creativeStorageId) continue;
      const url = await ctx.storage.getUrl(campaign.creativeStorageId);
      if (url) out.push({ campaignId: campaign._id, url, contentType: campaign.creativeContentType ?? null });
    }
    return out;
  },
});

/**
 * What the display shows. Each 30-second window plays the round that won it
 * (only once it is paid with a settlement transaction); otherwise our house
 * ad. Meanwhile the next window's round is bidding. The query never reads
 * the clock: it returns the recent windows with their times and the client
 * picks the one on air now, so the subscription never churns.
 */
const creativeView = v.object({
  provider: v.union(v.literal("file"), v.literal("youtube")),
  youtubeVideoId: v.union(v.string(), v.null()),
  title: v.union(v.string(), v.null()),
});
const windowView = v.object({
  roundId: v.id("rounds"),
  campaignId: v.union(v.id("campaigns"), v.null()),
  spotStartAt: v.number(),
  spotEndAt: v.number(),
  status: v.union(v.literal("bidding"), v.literal("awarded"), v.literal("paid"), v.literal("unsold")),
  company: v.union(v.string(), v.null()),
  priceMinor: v.union(v.number(), v.null()),
  txShort: v.union(v.string(), v.null()),
  txUrl: v.union(v.string(), v.null()),
  creative: v.union(creativeView, v.null()),
});

async function windowOf(ctx: QueryCtx, round: Doc<"rounds">): Promise<Infer<typeof windowView>> {
  const winner = round.winnerBidId ? await ctx.db.get(round.winnerBidId) : null;
  const campaign = winner ? await ctx.db.get(winner.campaignId) : null;
  let creative: Infer<typeof creativeView> | null = null;
  if (campaign?.creativeContentType === YOUTUBE_CONTENT_TYPE) {
    const yt = await youtubeOf(ctx, campaign._id);
    if (yt) creative = { provider: "youtube", youtubeVideoId: yt.videoId, title: yt.title ?? null };
  } else if (campaign?.creativeStorageId) {
    creative = { provider: "file", youtubeVideoId: null, title: null };
  }
  // Only a settlement transaction hash counts as proof of payment.
  const tx = round.status === "paid" ? (round.paymentTx ?? null) : null;
  return {
    roundId: round._id,
    campaignId: campaign?._id ?? null,
    spotStartAt: round.spotStartAt,
    spotEndAt: round.spotEndAt,
    status: round.status,
    company: winner ? ((await ctx.db.get(winner.advertiserId))?.displayName ?? "A company") : null,
    priceMinor: round.priceMinor ?? null,
    txShort: tx ? `${tx.slice(0, 6)}…${tx.slice(-4)}` : null,
    txUrl: tx && round.paymentNetwork ? (explorerTxUrl(round.paymentNetwork, tx) ?? null) : null,
    creative,
  };
}

export const screenState = query({
  args: { billboardId: v.id("billboards") },
  returns: v.object({
    screenName: v.string(),
    /** The round selling the next window (who offered what stays private: counts only). */
    bidding: v.union(
      v.null(),
      v.object({ closesAt: v.number(), windowStartAt: v.number(), offered: v.number(), answered: v.number(), agreed: v.number(), peopleInView: v.union(v.number(), v.null()) }),
    ),
    /** The latest windows, newest first; the client plays the paid one whose time covers now. */
    windows: v.array(windowView),
  }),
  handler: async (ctx, args) => {
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    const rounds = await ctx.db
      .query("rounds")
      .withIndex("by_billboard_and_createdAt", (q) => q.eq("billboardId", billboard._id))
      .order("desc")
      .take(3);
    const open = rounds.find((r) => r.status === "bidding") ?? null;
    let bidding = null;
    if (open) {
      const bids = await ctx.db
        .query("roundBids")
        .withIndex("by_round", (q) => q.eq("roundId", open._id))
        .take(20);
      bidding = {
        closesAt: open.closesAt,
        windowStartAt: open.spotStartAt,
        offered: bids.length,
        answered: bids.filter((b) => b.amountMinor !== null || b.status === "passed").length,
        agreed: bids.filter((b) => b.status === "bid").length,
        peopleInView: open.crowd,
      };
    }
    const windows = [];
    for (const r of rounds) if (r.status !== "bidding") windows.push(await windowOf(ctx, r));
    return { screenName: billboard.name, bidding, windows };
  },
});
