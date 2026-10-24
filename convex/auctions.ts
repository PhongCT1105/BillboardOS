import { ConvexError, v, type Infer } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { auctionStatus } from "./schema";
import { recordAudit } from "./lib/audit";
import { HOLD_TTL_MS, MAX_KEY_LENGTH, QUOTE_TTL_MS } from "./lib/constants";
import { requireCampaignAccess, requireWorkspaceMember, workspaceOfBillboard } from "./lib/tenancy";
import { computeScreenPrice } from "./lib/screenPrice";
import { loadTrailingAudience } from "./lib/audienceWindow";
import { effectiveBaseline } from "./lib/pricing";
import { eventStage } from "./lib/stages";
import { usd } from "./lib/reconcile";
import {
  CONTENTION_WINDOW_MS,
  DEFAULT_DURATION_MS,
  DEFAULT_INCREMENT,
  HARD_CAP_EXTRA_MS,
  MAX_SLOTS_PER_AUCTION,
  SOFT_CLOSE_MS,
  bidderLabel,
  extendForSoftClose,
  hashKey,
  hotReasons,
  minNextBid,
  resolveProxy,
} from "./lib/auction";
import { takeHold } from "./holds";
import { scheduleMatch } from "./watch";

const MAX_PARTICIPANTS = 50;
const MAX_BIDS_READ = 200;
const LADDER_SIZE = 20;
/** The auction (incl. soft-close cap) plus the winner's payment window must finish before air time. */
const AIRTIME_MARGIN_MS = HOLD_TTL_MS + 60_000;
const RECENT_CLOSED_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

async function openAuction(
  ctx: MutationCtx,
  input: { slotIds: Id<"slots">[]; openedBy: string; reason: string; durationMs: number },
): Promise<Id<"auctions">> {
  if (input.slotIds.length === 0 || input.slotIds.length > MAX_SLOTS_PER_AUCTION) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `An auction covers 1..${MAX_SLOTS_PER_AUCTION} slots` });
  }
  if (new Set(input.slotIds).size !== input.slotIds.length) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Duplicate slot ids" });
  }
  const now = Date.now();
  const endsAt = now + input.durationMs;
  const hardEndsAt = endsAt + HARD_CAP_EXTRA_MS;
  const slots: Doc<"slots">[] = [];
  for (const slotId of input.slotIds) {
    const slot = await ctx.db.get(slotId);
    if (!slot) throw new ConvexError({ code: "NOT_FOUND", message: "Slot not found" });
    if (slot.state !== "available") {
      throw new ConvexError({ code: "SLOT_UNAVAILABLE", message: "Only available slots can be auctioned", slotId });
    }
    if (slot.auctionId) {
      const existing = await ctx.db.get(slot.auctionId);
      if (existing?.status === "open") {
        throw new ConvexError({ code: "AUCTION_OPEN", message: "Slot already has an open auction", auctionId: existing._id });
      }
    }
    if (slot.startAt < hardEndsAt + AIRTIME_MARGIN_MS) {
      throw new ConvexError({ code: "SLOT_TOO_SOON", message: "Not enough time before air time to run an auction", slotId });
    }
    slots.push(slot);
  }
  const billboardId = slots[0].billboardId;
  if (slots.some((s) => s.billboardId !== billboardId)) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "All slots must be on the same billboard" });
  }
  const billboard = (await ctx.db.get(billboardId))!;
  // Reserve = the screen price from the harness (no company valuation in auctions).
  const { price } = await computeScreenPrice(ctx.db, billboard, slots, now);
  const traceId = `auction_${crypto.randomUUID()}`;
  const auctionId = await ctx.db.insert("auctions", {
    workspaceId: billboard.workspaceId,
    billboardId,
    slotIds: input.slotIds,
    reserveMinor: price.amountMinor,
    currentMinor: price.amountMinor,
    status: "open",
    openedAt: now,
    endsAt,
    hardEndsAt,
    incrementRule: DEFAULT_INCREMENT,
    softCloseMs: SOFT_CLOSE_MS,
    openedBy: input.openedBy,
    openReason: input.reason.slice(0, 500),
    traceId,
    extensions: 0,
  });
  for (const slot of slots) await ctx.db.patch(slot._id, { auctionId });
  await ctx.scheduler.runAt(endsAt, internal.auctions.close, { auctionId });
  await scheduleMatch(ctx, { slotIds: input.slotIds, reason: "auction opened" });
  await recordAudit(ctx, {
    workspaceId: billboard.workspaceId,
    traceId,
    actor: input.openedBy,
    type: "auction.opened",
    subjectId: auctionId,
    reason: `Auction for ${slots.length} slot(s) on ${billboard.name}, reserve ${usd(price.amountMinor)}, closes ${new Date(endsAt).toISOString()}: ${input.reason}`.slice(0, 1000),
    data: { slotIds: input.slotIds, reserveMinor: price.amountMinor, endsAt, hardEndsAt },
  });
  return auctionId;
}

/** Operator opens an auction for 1-4 available slots (default 2 minutes, soft close, +3 min hard cap). */
export const open = mutation({
  args: {
    slotIds: v.array(v.id("slots")),
    durationMinutes: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  returns: v.object({ auctionId: v.id("auctions") }),
  handler: async (ctx, args) => {
    const firstSlot = args.slotIds[0] ? await ctx.db.get(args.slotIds[0]) : null;
    if (!firstSlot) throw new ConvexError({ code: "NOT_FOUND", message: "Slot not found" });
    const operator = await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, firstSlot.billboardId));
    const minutes = args.durationMinutes ?? DEFAULT_DURATION_MS / 60_000;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 30) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "durationMinutes must be between 1 and 30" });
    }
    const auctionId = await openAuction(ctx, {
      slotIds: args.slotIds,
      openedBy: operator.actor,
      reason: args.reason?.trim() || "Opened by operator",
      durationMs: Math.round(minutes * 60_000),
    });
    return { auctionId };
  },
});

/** Distinct campaigns with an open quote on the slot created within the last 10 minutes. */
async function contentionFor(db: QueryCtx["db"], slot: Doc<"slots">, now: number): Promise<number> {
  const quotes = await db
    .query("quotes")
    .withIndex("by_billboard_and_expiresAt", (q) => q.eq("billboardId", slot.billboardId).gt("expiresAt", now))
    .take(100);
  const buyers = new Set<string>();
  for (const q of quotes) {
    if (q.status === "open" && q._creationTime >= now - CONTENTION_WINDOW_MS && q.slotIds.includes(slot._id)) {
      buyers.add(q.campaignId);
    }
  }
  return buyers.size;
}

/**
 * Seller agent: open an auction for a slot if it is hot per ADR 0003
 * (2+ buyers within 10 min, crowd >= 1.5x normal, or an event uplift).
 * Scheduled by quotes.create when a second buyer quotes the same slot.
 */
export const openIfHot = internalMutation({
  args: { slotId: v.id("slots") },
  returns: v.object({ opened: v.boolean(), auctionId: v.union(v.id("auctions"), v.null()), reasons: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const slot = await ctx.db.get(args.slotId);
    if (!slot || slot.state !== "available") return { opened: false, auctionId: null, reasons: [] };
    if (slot.auctionId) {
      const existing = await ctx.db.get(slot.auctionId);
      if (existing && existing.status !== "failed") return { opened: false, auctionId: existing._id, reasons: [] };
    }
    const billboard = (await ctx.db.get(slot.billboardId))!;
    const { sample } = await loadTrailingAudience(ctx.db, billboard._id, now);
    const crowdRatio =
      sample && (sample.window?.coverage ?? 0) >= 0.5 ? sample.countEstimate / effectiveBaseline(billboard.audienceBaselinePerBucket) : null;
    const events = await ctx.db
      .query("events")
      .withIndex("by_billboard_and_startsAt", (q) =>
        q.eq("billboardId", billboard._id).gte("startsAt", slot.startAt - 24 * 3600_000).lte("startsAt", slot.startAt + 30 * 60_000),
      )
      .take(20);
    const event = eventStage(slot.startAt, events);
    const reasons = hotReasons({
      distinctBuyers: await contentionFor(ctx.db, slot, now),
      crowdRatio,
      eventUplift: 1 + (event.multiplier - 1) * event.confidence,
    });
    if (reasons.length === 0) return { opened: false, auctionId: null, reasons };
    if (slot.startAt < now + DEFAULT_DURATION_MS + HARD_CAP_EXTRA_MS + AIRTIME_MARGIN_MS) {
      return { opened: false, auctionId: null, reasons: [...reasons, "too close to air time to auction"] };
    }
    const auctionId = await openAuction(ctx, {
      slotIds: [slot._id],
      openedBy: "agent:seller",
      reason: `Hot slot: ${reasons.join("; ")}`,
      durationMs: DEFAULT_DURATION_MS,
    });
    return { opened: true, auctionId, reasons };
  },
});

// ---------------------------------------------------------------------------
// Bidding
// ---------------------------------------------------------------------------

async function participantsOf(db: QueryCtx["db"], auctionId: Id<"auctions">) {
  return await db
    .query("auctionParticipants")
    .withIndex("by_auction", (q) => q.eq("auctionId", auctionId))
    .take(MAX_PARTICIPANTS);
}

async function recentBids(db: QueryCtx["db"], auctionId: Id<"auctions">) {
  return await db
    .query("bids")
    .withIndex("by_auction", (q) => q.eq("auctionId", auctionId))
    .order("desc")
    .take(MAX_BIDS_READ);
}

async function lastBidOf(db: QueryCtx["db"], auctionId: Id<"auctions">, participantId: Id<"auctionParticipants">) {
  const bids = await recentBids(db, auctionId);
  return bids.find((b) => b.participantId === participantId) ?? null;
}

/** Authenticate a bidder: campaign + its bidder key. */
async function authBidder(
  ctx: QueryCtx,
  auctionId: Id<"auctions">,
  campaignId: Id<"campaigns">,
  bidderKey: string,
): Promise<{ auction: Doc<"auctions">; participant: Doc<"auctionParticipants">; campaign: Doc<"campaigns"> }> {
  // Callers authorize the campaign first (session: requireCampaignAccess; agent API: key + allowlist).
  const auction = await ctx.db.get(auctionId);
  if (!auction) throw new ConvexError({ code: "NOT_FOUND", message: "Auction not found" });
  const participant = await ctx.db
    .query("auctionParticipants")
    .withIndex("by_auction_and_campaign", (q) => q.eq("auctionId", auctionId).eq("campaignId", campaignId))
    .unique();
  if (!participant || participant.keyHash !== (await hashKey(bidderKey))) {
    throw new ConvexError({ code: "FORBIDDEN", message: "Unknown bidder or wrong bidder key; call auctions.join first" });
  }
  const campaign = (await ctx.db.get(campaignId))!;
  return { auction, participant, campaign };
}

function assertOpen(auction: Doc<"auctions">, now: number) {
  if (auction.status !== "open" || now >= auction.endsAt) {
    throw new ConvexError({ code: "AUCTION_CLOSED", message: "This auction is no longer taking bids" });
  }
}

function assertAmount(name: string, amount: number, budgetMinor: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `${name} must be a positive integer (US cents)` });
  }
  if (amount > budgetMinor) {
    throw new ConvexError({
      code: "BUDGET_EXCEEDED",
      message: `${name} ${usd(amount)} exceeds the campaign budget ${usd(budgetMinor)}`,
    });
  }
}

/**
 * Recompute leader and price from everyone's effective maximum, write the
 * proxy bids that make the public ladder consistent, and apply soft close.
 */
async function reprice(ctx: MutationCtx, auctionId: Id<"auctions">, now: number, actor: string) {
  const auction = (await ctx.db.get(auctionId))!;
  const parts = await participantsOf(ctx.db, auctionId);
  const res = resolveProxy(
    parts.map((p) => ({ id: p._id, effectiveMaxMinor: p.effectiveMaxMinor, manualTopMinor: p.manualTopMinor, maxSetAt: p.maxSetAt })),
    auction.reserveMinor,
    auction.incrementRule,
  );
  const changed = res.leaderId !== (auction.leaderParticipantId ?? null) || res.priceMinor !== auction.currentMinor;
  if (res.leaderId && changed) {
    if (res.secondId) {
      const second = parts.find((p) => p._id === res.secondId)!;
      const last = await lastBidOf(ctx.db, auctionId, second._id);
      if (second.effectiveMaxMinor > (last?.amountMinor ?? 0)) {
        await ctx.db.insert("bids", {
          auctionId,
          campaignId: second.campaignId,
          participantId: second._id,
          bidderLabel: second.label,
          amountMinor: second.effectiveMaxMinor,
          isAuto: true,
          createdAt: now,
        });
      }
    }
    const leader = parts.find((p) => p._id === res.leaderId)!;
    const last = await lastBidOf(ctx.db, auctionId, leader._id);
    if (last?.amountMinor !== res.priceMinor) {
      await ctx.db.insert("bids", {
        auctionId,
        campaignId: leader.campaignId,
        participantId: leader._id,
        bidderLabel: leader.label,
        amountMinor: res.priceMinor,
        isAuto: res.priceMinor !== leader.manualTopMinor,
        createdAt: now,
      });
    }
  }
  const patch: Partial<Doc<"auctions">> = {
    leaderParticipantId: res.leaderId ?? undefined,
    currentMinor: res.priceMinor,
  };
  if (changed) {
    const newEnds = extendForSoftClose(now, auction.endsAt, auction.hardEndsAt, auction.softCloseMs);
    if (newEnds > auction.endsAt) {
      patch.endsAt = newEnds;
      patch.extensions = auction.extensions + 1;
      await recordAudit(ctx, {
        workspaceId: auction.workspaceId,
        traceId: auction.traceId,
        actor: "system",
        type: "auction.extended",
        subjectId: auctionId,
        reason: `Bid in the final ${auction.softCloseMs / 1000}s: close extended to ${new Date(newEnds).toISOString()}${newEnds === auction.hardEndsAt ? " (hard cap)" : ""}`,
      });
    }
  }
  await ctx.db.patch(auctionId, patch);
  if (changed) {
    const leader = parts.find((p) => p._id === res.leaderId);
    await recordAudit(ctx, {
      workspaceId: auction.workspaceId,
      traceId: auction.traceId,
      actor,
      type: "auction.bid",
      subjectId: auctionId,
      reason: leader
        ? `${leader.label} leads at ${usd(res.priceMinor)}`
        : `No leader; price at reserve ${usd(res.priceMinor)}`,
      data: { priceMinor: res.priceMinor, leader: leader?.label ?? null },
    });
  }
  return (await ctx.db.get(auctionId))!;
}

const bidResult = v.object({
  leading: v.boolean(),
  leaderLabel: v.union(v.string(), v.null()),
  currentMinor: v.number(),
  minNextBidMinor: v.number(),
  endsAt: v.number(),
});

async function bidResultFor(ctx: QueryCtx, auction: Doc<"auctions">, participantId: Id<"auctionParticipants">) {
  const leader = auction.leaderParticipantId ? await ctx.db.get(auction.leaderParticipantId) : null;
  return {
    leading: auction.leaderParticipantId === participantId,
    leaderLabel: leader?.label ?? null,
    currentMinor: auction.currentMinor,
    minNextBidMinor: minNextBid(
      { hasLeader: !!auction.leaderParticipantId, currentMinor: auction.currentMinor, reserveMinor: auction.reserveMinor },
      auction.incrementRule,
    ),
    endsAt: auction.endsAt,
  };
}

/**
 * Register a campaign as a bidder. Returns the bidder key that every later
 * bid must present (stored hashed). Pass your own `clientKey` to make joining
 * idempotent; without it the key is generated and shown only once.
 */
export const joinResult = v.object({
    participantId: v.id("auctionParticipants"),
    bidderLabel: v.string(),
    bidderKey: v.string(),
    reserveMinor: v.number(),
    minNextBidMinor: v.number(),
    endsAt: v.number(),
  });

export const join = mutation({
  args: { auctionId: v.id("auctions"), campaignId: v.id("campaigns"), clientKey: v.optional(v.string()) },
  returns: joinResult,
  handler: async (ctx, args) => {
    await requireCampaignAccess(ctx, args.campaignId);
    return await joinCore(ctx, args);
  },
});

/** Shared by the signed-in customer path and the agent API (campaign already authorized). */
export async function joinCore(
  ctx: MutationCtx,
  args: { auctionId: Id<"auctions">; campaignId: Id<"campaigns">; clientKey?: string; agentKeyId?: Id<"agentKeys"> },
): Promise<Infer<typeof joinResult>> {
  const now = Date.now();
  const auction = await ctx.db.get(args.auctionId);
  if (!auction) throw new ConvexError({ code: "NOT_FOUND", message: "Auction not found" });
  assertOpen(auction, now);
  const campaign = await ctx.db.get(args.campaignId);
  if (!campaign) throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found" });
  if (campaign.status === "completed" || campaign.status === "cancelled") {
    throw new ConvexError({ code: "CAMPAIGN_CLOSED", message: `Campaign is ${campaign.status}` });
  }
  if (campaign.budgetMinor < auction.reserveMinor) {
    throw new ConvexError({
      code: "BUDGET_EXCEEDED",
      message: `Campaign budget ${usd(campaign.budgetMinor)} is below the reserve ${usd(auction.reserveMinor)}`,
    });
  }
  if (args.clientKey !== undefined && (args.clientKey.length < 16 || args.clientKey.length > MAX_KEY_LENGTH)) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `clientKey must be 16..${MAX_KEY_LENGTH} characters` });
  }
  const key = args.clientKey ?? `bk_${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const keyHash = await hashKey(key);
  const existing = await ctx.db
    .query("auctionParticipants")
    .withIndex("by_auction_and_campaign", (q) => q.eq("auctionId", args.auctionId).eq("campaignId", args.campaignId))
    .unique();
  const nextMin = minNextBid(
    { hasLeader: !!auction.leaderParticipantId, currentMinor: auction.currentMinor, reserveMinor: auction.reserveMinor },
    auction.incrementRule,
  );
  if (existing) {
    if (existing.keyHash !== keyHash) {
      throw new ConvexError({ code: "ALREADY_JOINED", message: "This campaign already joined with a different key" });
    }
    return {
      participantId: existing._id,
      bidderLabel: existing.label,
      bidderKey: key,
      reserveMinor: auction.reserveMinor,
      minNextBidMinor: nextMin,
      endsAt: auction.endsAt,
    };
  }
  const count = (await participantsOf(ctx.db, args.auctionId)).length;
  if (count >= MAX_PARTICIPANTS) throw new ConvexError({ code: "AUCTION_FULL", message: "Too many bidders" });
  const label = bidderLabel(count);
  const participantId = await ctx.db.insert("auctionParticipants", {
    auctionId: args.auctionId,
    campaignId: args.campaignId,
    label,
    keyHash,
    agentKeyId: args.agentKeyId,
    manualTopMinor: 0,
    effectiveMaxMinor: 0,
    maxSetAt: now,
  });
  await recordAudit(ctx, {
    workspaceId: auction.workspaceId,
    traceId: auction.traceId,
    actor: `campaign:${args.campaignId}`,
    type: "auction.joined",
    subjectId: args.auctionId,
    reason: `${label} joined`,
  });
  return {
    participantId,
    bidderLabel: label,
    bidderKey: key,
    reserveMinor: auction.reserveMinor,
    minNextBidMinor: nextMin,
    endsAt: auction.endsAt,
  };
}

/** Place a public bid: must beat the current price by the increment (5%, >= $1) and stay within budget. */
export const bid = mutation({
  args: { auctionId: v.id("auctions"), campaignId: v.id("campaigns"), bidderKey: v.string(), amountMinor: v.number() },
  returns: bidResult,
  handler: async (ctx, args) => {
    await requireCampaignAccess(ctx, args.campaignId);
    return await bidCore(ctx, args);
  },
});

/** Shared by the signed-in customer path and the agent API (campaign already authorized). */
export async function bidCore(
  ctx: MutationCtx,
  args: { auctionId: Id<"auctions">; campaignId: Id<"campaigns">; bidderKey: string; amountMinor: number },
): Promise<Infer<typeof bidResult>> {
  const now = Date.now();
  const { auction, participant, campaign } = await authBidder(ctx, args.auctionId, args.campaignId, args.bidderKey);
  assertOpen(auction, now);
  assertAmount("Bid", args.amountMinor, campaign.budgetMinor);
  if (auction.leaderParticipantId === participant._id) {
    throw new ConvexError({ code: "ALREADY_LEADING", message: "You are already leading; raise your auto-bid instead" });
  }
  const minNext = minNextBid(
    { hasLeader: !!auction.leaderParticipantId, currentMinor: auction.currentMinor, reserveMinor: auction.reserveMinor },
    auction.incrementRule,
  );
  if (args.amountMinor < minNext) {
    throw new ConvexError({ code: "BID_TOO_LOW", message: `Bid at least ${usd(minNext)}`, minNextBidMinor: minNext });
  }
  await ctx.db.insert("bids", {
    auctionId: auction._id,
    campaignId: args.campaignId,
    participantId: participant._id,
    bidderLabel: participant.label,
    amountMinor: args.amountMinor,
    isAuto: false,
    createdAt: now,
  });
  const effective = Math.min(campaign.budgetMinor, Math.max(participant.effectiveMaxMinor, args.amountMinor));
  await ctx.db.patch(participant._id, {
    manualTopMinor: Math.max(participant.manualTopMinor, args.amountMinor),
    effectiveMaxMinor: effective,
    maxSetAt: effective > participant.effectiveMaxMinor ? now : participant.maxSetAt,
  });
  const updated = await reprice(ctx, auction._id, now, `${participant.label} (campaign ${args.campaignId})`);
  return await bidResultFor(ctx, updated, participant._id);
}

/**
 * Set or change your private auto-bid maximum. The system bids for you, one
 * increment at a time, up to this amount. Raising is always allowed; lowering
 * below the current price (if leading) or the next minimum bid is not.
 */
export const setAutoBid = mutation({
  args: { auctionId: v.id("auctions"), campaignId: v.id("campaigns"), bidderKey: v.string(), maxMinor: v.number() },
  returns: bidResult,
  handler: async (ctx, args) => {
    await requireCampaignAccess(ctx, args.campaignId);
    return await setAutoBidCore(ctx, args);
  },
});

/** Shared by the signed-in customer path and the agent API (campaign already authorized). */
export async function setAutoBidCore(
  ctx: MutationCtx,
  args: { auctionId: Id<"auctions">; campaignId: Id<"campaigns">; bidderKey: string; maxMinor: number },
): Promise<Infer<typeof bidResult>> {
  const now = Date.now();
  const { auction, participant, campaign } = await authBidder(ctx, args.auctionId, args.campaignId, args.bidderKey);
  assertOpen(auction, now);
  assertAmount("Auto-bid maximum", args.maxMinor, campaign.budgetMinor);
  const leading = auction.leaderParticipantId === participant._id;
  const floor = leading
    ? auction.currentMinor
    : minNextBid(
        { hasLeader: !!auction.leaderParticipantId, currentMinor: auction.currentMinor, reserveMinor: auction.reserveMinor },
        auction.incrementRule,
      );
  if (args.maxMinor < floor) {
    throw new ConvexError({
      code: "AUTO_BID_TOO_LOW",
      message: leading ? `You lead at ${usd(floor)}; your maximum can't be lower` : `Set at least ${usd(floor)}`,
      minMinor: floor,
    });
  }
  const existing = await ctx.db
    .query("autoBids")
    .withIndex("by_auction_and_campaign", (q) => q.eq("auctionId", auction._id).eq("campaignId", args.campaignId))
    .unique();
  if (existing) await ctx.db.patch(existing._id, { maxMinor: args.maxMinor, updatedAt: now });
  else {
    await ctx.db.insert("autoBids", {
      auctionId: auction._id,
      campaignId: args.campaignId,
      participantId: participant._id,
      maxMinor: args.maxMinor,
      updatedAt: now,
    });
  }
  const effective = Math.min(campaign.budgetMinor, Math.max(participant.manualTopMinor, args.maxMinor));
  await ctx.db.patch(participant._id, {
    effectiveMaxMinor: effective,
    maxSetAt: effective > participant.effectiveMaxMinor ? now : participant.maxSetAt,
  });
  await recordAudit(ctx, {
    workspaceId: auction.workspaceId,
    traceId: auction.traceId,
    actor: `campaign:${args.campaignId}`,
    type: "auction.auto_bid_set",
    subjectId: auction._id,
    // The maximum itself stays private, even in the audit text.
    reason: `${participant.label} ${existing ? "changed" : "set"} an auto-bid`,
  });
  const updated = await reprice(ctx, auction._id, now, `${participant.label} (auto)`);
  return await bidResultFor(ctx, updated, participant._id);
}

// ---------------------------------------------------------------------------
// Closing, award, default
// ---------------------------------------------------------------------------

/** Give `participant` a hold at `amountMinor` through the normal hold logic. */
async function award(
  ctx: MutationCtx,
  auction: Doc<"auctions">,
  participant: Doc<"auctionParticipants">,
  amountMinor: number,
  role: "winner" | "runner-up",
): Promise<Doc<"holds"> | null> {
  const now = Date.now();
  const quoteId = await ctx.db.insert("quotes", {
    workspaceId: auction.workspaceId,
    campaignId: participant.campaignId,
    billboardId: auction.billboardId,
    slotIds: auction.slotIds,
    amountMinor,
    currency: "USD",
    expiresAt: now + QUOTE_TTL_MS,
    pricingBasis: [
      `Auction ${auction._id}: ${role === "winner" ? "winning bid" : "runner-up offer at their last bid"} ${usd(amountMinor)} (reserve ${usd(auction.reserveMinor)})`,
    ],
    confidence: "high",
    policyVersion: "auction-v1",
    status: "open",
    traceId: auction.traceId,
    screenAmountMinor: auction.reserveMinor,
  });
  await ctx.scheduler.runAt(now + QUOTE_TTL_MS, internal.quotes.expire, { quoteId });
  const holdKey = `ah_${crypto.randomUUID()}`.replace(/-/g, "");
  try {
    const hold = await takeHold(ctx, (await ctx.db.get(quoteId))!, holdKey, `auction:${participant.label}`, {
      auctionId: auction._id,
      agentKeyId: participant.agentKeyId,
    });
    await ctx.db.patch(participant._id, { holdKey });
    await ctx.db.patch(auction._id, {
      winnerParticipantId: participant._id,
      winningBidMinor: amountMinor,
      winnerHoldId: hold._id,
    });
    return hold;
  } catch (error) {
    if (error instanceof ConvexError) {
      await ctx.db.patch(quoteId, { status: "expired" });
      return null;
    }
    throw error;
  }
}

/** Scheduled at endsAt; reschedules itself after soft-close extensions. */
export const close = internalMutation({
  args: { auctionId: v.id("auctions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const auction = await ctx.db.get(args.auctionId);
    if (!auction || auction.status !== "open") return null;
    const now = Date.now();
    if (now < auction.endsAt) {
      await ctx.scheduler.runAt(auction.endsAt, internal.auctions.close, { auctionId: auction._id });
      return null;
    }
    await ctx.db.patch(auction._id, { status: "closed", closedAt: now });
    const leader = auction.leaderParticipantId ? await ctx.db.get(auction.leaderParticipantId) : null;
    if (!leader) {
      await ctx.db.patch(auction._id, { status: "failed", outcomeNote: "No bids at or above the reserve" });
      await recordAudit(ctx, {
        workspaceId: auction.workspaceId,
        traceId: auction.traceId,
        actor: "system",
        type: "auction.failed",
        subjectId: auction._id,
        reason: `Closed with no bids at or above the reserve ${usd(auction.reserveMinor)}`,
      });
      return null;
    }
    const hold = await award(ctx, auction, leader, auction.currentMinor, "winner");
    if (!hold) {
      await ctx.db.patch(auction._id, { status: "failed", outcomeNote: "Slot no longer available at close" });
      await recordAudit(ctx, {
        workspaceId: auction.workspaceId,
        traceId: auction.traceId,
        actor: "system",
        type: "auction.failed",
        subjectId: auction._id,
        reason: "Winner could not be given a hold: slot no longer available",
      });
      return null;
    }
    await recordAudit(ctx, {
      workspaceId: auction.workspaceId,
      traceId: auction.traceId,
      actor: "system",
      type: "auction.closed",
      subjectId: auction._id,
      reason: `${leader.label} won at ${usd(auction.currentMinor)} (reserve ${usd(auction.reserveMinor)}, ${auction.extensions} extension(s)); hold until ${new Date(hold.expiresAt).toISOString()}`,
      data: { winner: leader.label, priceMinor: auction.currentMinor, holdId: hold._id, campaignId: leader.campaignId },
    });
    return null;
  },
});

/**
 * The winner's hold ended without payment (expired or released): record a
 * `winner_default` finance exception and offer the slot to the runner-up at
 * their last bid. No-op if the hold was paid or isn't the current award.
 */
export const handleWinnerDefault = internalMutation({
  args: { auctionId: v.id("auctions"), holdId: v.id("holds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const auction = await ctx.db.get(args.auctionId);
    const hold = await ctx.db.get(args.holdId);
    if (!auction || !hold || auction.status !== "closed" || auction.winnerHoldId !== args.holdId) return null;
    if (hold.status === "converted" || hold.status === "active") return null;
    const defaulter = (await ctx.db.get(auction.winnerParticipantId!))!;
    const campaign = await ctx.db.get(defaulter.campaignId);
    const defaulted = [...(auction.defaultedParticipantIds ?? []), defaulter._id];
    await ctx.db.patch(auction._id, { defaultedParticipantIds: defaulted });
    await ctx.db.insert("financeExceptions", {
      workspaceId: auction.workspaceId,
      kind: "winner_default",
      status: "open",
      holdId: hold._id,
      billboardId: auction.billboardId,
      advertiserId: campaign?.advertiserId,
      expectedMinor: auction.winningBidMinor ?? hold.amountMinor,
      observedMinor: 0,
      evidence: `${defaulter.label} won auction ${auction._id} at ${usd(auction.winningBidMinor ?? hold.amountMinor)} but the hold ${hold.status === "expired" ? "expired unpaid" : "was released"} at ${new Date(hold.expiresAt).toISOString()}.`,
      nextAction: "Slot offered to the runner-up at their last bid. Review the defaulting buyer's terms before they bid again.",
    });
    await recordAudit(ctx, {
      workspaceId: auction.workspaceId,
      traceId: auction.traceId,
      actor: "system",
      type: "auction.winner_default",
      subjectId: auction._id,
      reason: `${defaulter.label} did not pay ${usd(auction.winningBidMinor ?? hold.amountMinor)} in time`,
      data: { holdId: hold._id, winner: defaulter.label },
    });

    // Runner-up: highest remaining effective maximum with a bid at or above the reserve.
    const parts = (await participantsOf(ctx.db, auction._id))
      .filter((p) => !defaulted.includes(p._id))
      .sort((a, b) => b.effectiveMaxMinor - a.effectiveMaxMinor || a.maxSetAt - b.maxSetAt);
    for (const p of parts) {
      const last = await lastBidOf(ctx.db, auction._id, p._id);
      if (!last || last.amountMinor < auction.reserveMinor) continue;
      const offered = await award(ctx, auction, p, last.amountMinor, "runner-up");
      if (!offered) break;
      await recordAudit(ctx, {
        workspaceId: auction.workspaceId,
        traceId: auction.traceId,
        actor: "agent:seller",
        type: "auction.runner_up_offered",
        subjectId: auction._id,
        reason: `Offered to ${p.label} at their last bid ${usd(last.amountMinor)}; hold until ${new Date(offered.expiresAt).toISOString()}`,
        data: { participant: p.label, amountMinor: last.amountMinor, holdId: offered._id },
      });
      return null;
    }
    await ctx.db.patch(auction._id, { status: "failed", outcomeNote: "Winner defaulted and no runner-up was available" });
    await recordAudit(ctx, {
      workspaceId: auction.workspaceId,
      traceId: auction.traceId,
      actor: "system",
      type: "auction.failed",
      subjectId: auction._id,
      reason: "Winner defaulted and no runner-up was available; slot returns to posted sale",
    });
    return null;
  },
});

/** Called when an auction hold is paid/booked. */
export async function markAuctionSettled(ctx: MutationCtx, hold: Doc<"holds">, bookingId: Id<"bookings">): Promise<void> {
  if (!hold.auctionId) return;
  const auction = await ctx.db.get(hold.auctionId);
  if (!auction || auction.winnerHoldId !== hold._id || auction.status !== "closed") return;
  await ctx.db.patch(auction._id, { status: "settled", outcomeNote: `Paid and booked (${bookingId})` });
  await recordAudit(ctx, {
    workspaceId: auction.workspaceId,
    traceId: auction.traceId,
    actor: "system",
    type: "auction.settled",
    subjectId: auction._id,
    reason: `Winning hold paid at ${usd(hold.amountMinor)}; booking ${bookingId}`,
    data: { bookingId, holdId: hold._id },
  });
}

// ---------------------------------------------------------------------------
// Views (public; auto-bid maxima are never returned)
// ---------------------------------------------------------------------------

const auctionView = v.object({
  auctionId: v.id("auctions"),
  billboardId: v.id("billboards"),
  billboardName: v.string(),
  slots: v.array(v.object({ slotId: v.id("slots"), startAt: v.number(), endAt: v.number() })),
  status: auctionStatus,
  reserveMinor: v.number(),
  currentMinor: v.number(),
  minNextBidMinor: v.number(),
  leaderLabel: v.union(v.string(), v.null()),
  bidders: v.number(),
  openedAt: v.number(),
  endsAt: v.number(),
  hardEndsAt: v.number(),
  extensions: v.number(),
  openReason: v.string(),
  ladder: v.array(v.object({ bidderLabel: v.string(), amountMinor: v.number(), isAuto: v.boolean(), createdAt: v.number() })),
  winnerLabel: v.union(v.string(), v.null()),
  winningBidMinor: v.union(v.number(), v.null()),
  outcomeNote: v.union(v.string(), v.null()),
});

async function viewOf(ctx: QueryCtx, auction: Doc<"auctions">) {
  const billboard = await ctx.db.get(auction.billboardId);
  const slots = [];
  for (const id of auction.slotIds) {
    const s = await ctx.db.get(id);
    if (s) slots.push({ slotId: s._id, startAt: s.startAt, endAt: s.endAt });
  }
  const parts = await participantsOf(ctx.db, auction._id);
  const leader = parts.find((p) => p._id === auction.leaderParticipantId);
  const winner = parts.find((p) => p._id === auction.winnerParticipantId);
  const ladder = (await recentBids(ctx.db, auction._id)).slice(0, LADDER_SIZE).map((b) => ({
    bidderLabel: b.bidderLabel,
    amountMinor: b.amountMinor,
    isAuto: b.isAuto,
    createdAt: b.createdAt,
  }));
  return {
    auctionId: auction._id,
    billboardId: auction.billboardId,
    billboardName: billboard?.name ?? "Unknown screen",
    slots,
    status: auction.status,
    reserveMinor: auction.reserveMinor,
    currentMinor: auction.currentMinor,
    minNextBidMinor: minNextBid(
      { hasLeader: !!auction.leaderParticipantId, currentMinor: auction.currentMinor, reserveMinor: auction.reserveMinor },
      auction.incrementRule,
    ),
    leaderLabel: leader?.label ?? null,
    bidders: parts.length,
    openedAt: auction.openedAt,
    endsAt: auction.endsAt,
    hardEndsAt: auction.hardEndsAt,
    extensions: auction.extensions,
    openReason: auction.openReason,
    ladder,
    winnerLabel: winner?.label ?? null,
    winningBidMinor: auction.winningBidMinor ?? null,
    outcomeNote: auction.outcomeNote ?? null,
  };
}

/**
 * Open auctions plus those that ended in the last 15 minutes (max 20 each),
 * newest-ending last. The caller passes `now` (floored to the minute keeps
 * the subscription stable); queries never read the clock.
 */
export const live = query({
  args: { billboardId: v.optional(v.id("billboards")), now: v.number() },
  returns: v.array(auctionView),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.now)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "now must be a timestamp (ms)" });
    }
    const now = args.now;
    const rows: Doc<"auctions">[] = [];
    rows.push(
      ...(await ctx.db
        .query("auctions")
        .withIndex("by_status_and_endsAt", (q) => q.eq("status", "open"))
        .take(20)),
    );
    for (const status of ["closed", "settled", "failed"] as const) {
      rows.push(
        ...(await ctx.db
          .query("auctions")
          .withIndex("by_status_and_endsAt", (q) => q.eq("status", status).gte("endsAt", now - RECENT_CLOSED_MS))
          .take(20)),
      );
    }
    const filtered = rows
      .filter((a) => !args.billboardId || a.billboardId === args.billboardId)
      .sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || a.endsAt - b.endsAt);
    const out = [];
    for (const a of filtered) out.push(await viewOf(ctx, a));
    return out;
  },
});

/** The latest auction for a slot (open or finished), or null. */
export const forSlot = query({
  args: { slotId: v.id("slots") },
  returns: v.union(auctionView, v.null()),
  handler: async (ctx, args) => {
    const slot = await ctx.db.get(args.slotId);
    if (!slot?.auctionId) return null;
    const auction = await ctx.db.get(slot.auctionId);
    return auction ? await viewOf(ctx, auction) : null;
  },
});

/** A bidder's own view: whether it leads, its own maximum, and its hold if it won. */
export const myStatusResult = v.object({
    bidderLabel: v.string(),
    status: auctionStatus,
    outcome: v.union(
      v.literal("leading"),
      v.literal("outbid"),
      v.literal("not_bidding"),
      v.literal("won"),
      v.literal("lost"),
      v.literal("defaulted"),
      v.literal("failed"),
    ),
    myMaxMinor: v.number(),
    myLastBidMinor: v.union(v.number(), v.null()),
    currentMinor: v.number(),
    minNextBidMinor: v.number(),
    endsAt: v.number(),
    holdId: v.union(v.id("holds"), v.null()),
    holdKey: v.union(v.string(), v.null()),
    holdExpiresAt: v.union(v.number(), v.null()),
    amountMinor: v.union(v.number(), v.null()),
  });

export const myStatus = query({
  args: { auctionId: v.id("auctions"), campaignId: v.id("campaigns"), bidderKey: v.string() },
  returns: myStatusResult,
  handler: async (ctx, args) => {
    await requireCampaignAccess(ctx, args.campaignId);
    return await myStatusCore(ctx, args);
  },
});

/** Shared by the signed-in customer path and the agent API (campaign already authorized). */
export async function myStatusCore(
  ctx: QueryCtx,
  args: { auctionId: Id<"auctions">; campaignId: Id<"campaigns">; bidderKey: string },
): Promise<Infer<typeof myStatusResult>> {
  const { auction, participant } = await authBidder(ctx, args.auctionId, args.campaignId, args.bidderKey);
  const last = await lastBidOf(ctx.db, auction._id, participant._id);
  const isAwarded = auction.winnerParticipantId === participant._id;
  const hold = isAwarded && auction.winnerHoldId ? await ctx.db.get(auction.winnerHoldId) : null;
  let outcome: "leading" | "outbid" | "not_bidding" | "won" | "lost" | "defaulted" | "failed";
  if (auction.defaultedParticipantIds?.includes(participant._id)) outcome = "defaulted";
  else if (auction.status === "open") outcome = auction.leaderParticipantId === participant._id ? "leading" : last ? "outbid" : "not_bidding";
  else if (auction.status === "failed") outcome = "failed";
  else outcome = isAwarded ? "won" : "lost";
  return {
    bidderLabel: participant.label,
    status: auction.status,
    outcome,
    myMaxMinor: participant.effectiveMaxMinor,
    myLastBidMinor: last?.amountMinor ?? null,
    currentMinor: auction.currentMinor,
    minNextBidMinor: minNextBid(
      { hasLeader: !!auction.leaderParticipantId, currentMinor: auction.currentMinor, reserveMinor: auction.reserveMinor },
      auction.incrementRule,
    ),
    endsAt: auction.endsAt,
    holdId: hold?._id ?? null,
    holdKey: hold ? (participant.holdKey ?? null) : null,
    holdExpiresAt: hold?.expiresAt ?? null,
    amountMinor: isAwarded ? (auction.winningBidMinor ?? null) : null,
  };
}
