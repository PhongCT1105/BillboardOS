import { ConvexError, v } from "convex/values";
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
 * What the display shows, from the latest round on this screen: the sale in
 * progress, the paid ad playing, or "your ad here". The query never
 * reads the clock: it returns `spotEndAt` and the client decides when a paid
 * spot has expired, so the subscription never changes.
 */
type NowPlaying = {
  company: string;
  wonAtMinor: number;
  txShort: string | null;
  txUrl: string | null;
  creative?: { provider: "file" | "youtube"; youtubeVideoId: string | null; title: string | null };
};

/** The screen during a bidding round: bidding -> the bids; awarded -> settling; paid -> playing; unsold -> your ad here. */
async function roundScreen(ctx: QueryCtx, billboard: Doc<"billboards">, round: Doc<"rounds">) {
  const base = {
    screenName: billboard.name,
    minutesLeft: Math.max(1, Math.round((round.spotEndAt - round.spotStartAt) / 60_000)),
    peopleInView: round.crowd,
    eventName: round.eventName,
    openingMinor: round.askingMinor as number | null,
    minimumMinor: round.floorMinor as number | null,
    why: round.signals.map((s) => s.reason).join(" · ") as string | null,
    closesAt: null as number | null,
    spotEndAt: round.spotEndAt as number | null,
    nowPlaying: null as NowPlaying | null,
  };
  const bids = await ctx.db
    .query("roundBids")
    .withIndex("by_round", (q) => q.eq("roundId", round._id))
    .take(20);
  const name = async (id: Id<"advertisers">) => (await ctx.db.get(id))?.displayName ?? "A company";
  if (round.status === "bidding") {
    // Private: the public screen shows how many companies are negotiating, never who offered what.
    const sealedBids = bids.filter((b) => b.status === "invited" && b.amountMinor !== null).length;
    return { mode: "auction" as const, ...base, closesAt: round.closesAt, sealedBids };
  }
  if (round.status === "awarded") return { mode: "settling" as const, ...base };
  if (round.status === "paid") {
    const winner = bids.find((b) => b._id === round.winnerBidId);
    const campaign = winner ? await ctx.db.get(winner.campaignId) : null;
    let creative: NowPlaying["creative"];
    if (campaign?.creativeContentType === YOUTUBE_CONTENT_TYPE) {
      const yt = await youtubeOf(ctx, campaign._id);
      if (yt) creative = { provider: "youtube", youtubeVideoId: yt.videoId, title: yt.title ?? null };
    } else if (campaign?.creativeStorageId) {
      creative = { provider: "file", youtubeVideoId: null, title: null };
    }
    // Only a settlement transaction hash counts as proof of payment.
    const tx = round.paymentTx ?? null;
    const nowPlaying: NowPlaying = {
      company: winner ? await name(winner.advertiserId) : "A company",
      wonAtMinor: round.priceMinor ?? round.askingMinor,
      txShort: tx ? `${tx.slice(0, 6)}…${tx.slice(-4)}` : null,
      txUrl: tx && round.paymentNetwork ? (explorerTxUrl(round.paymentNetwork, tx) ?? null) : null,
      ...(creative ? { creative } : {}),
    };
    return { mode: "playing" as const, ...base, nowPlaying };
  }
  return { mode: "your_ad_here" as const, ...base };
}

export const screenState = query({
  args: { billboardId: v.id("billboards") },
  returns: v.object({
    mode: v.union(
      v.literal("auction"),
      v.literal("settling"),
      v.literal("playing"),
      v.literal("your_ad_here"),
    ),
    screenName: v.string(),
    minutesLeft: v.number(),
    peopleInView: v.union(v.number(), v.null()),
    eventName: v.union(v.string(), v.null()),
    openingMinor: v.union(v.number(), v.null()),
    minimumMinor: v.union(v.number(), v.null()),
    why: v.union(v.string(), v.null()),
    closesAt: v.union(v.number(), v.null()),
    /** Companies negotiating with an offer in (who offered what stays private). */
    sealedBids: v.optional(v.number()),
    /** End of the latest moment's spot; the client expires "playing" with its own clock. */
    spotEndAt: v.union(v.number(), v.null()),
    nowPlaying: v.union(
      v.null(),
      v.object({
        company: v.string(),
        wonAtMinor: v.number(),
        txShort: v.union(v.string(), v.null()),
        txUrl: v.union(v.string(), v.null()),
        /** The winner's creative: a YouTube video plays through the official embed. */
        creative: v.optional(
          v.object({
            provider: v.union(v.literal("file"), v.literal("youtube")),
            youtubeVideoId: v.union(v.string(), v.null()),
            title: v.union(v.string(), v.null()),
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    const empty = {
      screenName: billboard.name,
      minutesLeft: 0,
      peopleInView: null,
      eventName: null,
      openingMinor: null,
      minimumMinor: null,
      why: null,
      closesAt: null,
      spotEndAt: null,
      nowPlaying: null,
    };
    const round = await ctx.db
      .query("rounds")
      .withIndex("by_billboard_and_createdAt", (q) => q.eq("billboardId", billboard._id))
      .order("desc")
      .first();
    if (!round) return { mode: "your_ad_here" as const, ...empty };
    return await roundScreen(ctx, billboard, round);
  },
});
