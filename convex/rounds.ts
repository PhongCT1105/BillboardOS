import { ConvexError, v, type Infer } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { priceSignal, roundBidStatus, roundStatus, roundTrigger } from "./schemaParts/rounds";
import { recordAudit } from "./lib/audit";
import { assertWithinBudget, authenticateAgent, keyStatus } from "./lib/agentKeys";
import { holdLockKey, lockHeld } from "./lib/paymentLock";
import { endHold, takeHold } from "./holds";
import { AUTO_SELL_GAP_MS, CAMERA_COOLDOWN_MS, MAX_INVITES, MIN_MATCH, ROUND_CLOSE_MS, askingPrice, companyOffer, hostReply, priceSignals } from "./lib/rounds";
import { matchScore } from "./lib/match";
import { researchOf } from "./research";
import { MIN_REMAINING_MS, PAY_WINDOW_MS, PRICING_POLICY_VERSION, activeEvent, campaignsReadyFor, replyAllowed, spentTodayForAdvertiserMinor } from "./lib/sale";
import { requireCustomer, requireWorkspaceMember, resolveWorkspace, workspaceOfBillboard } from "./lib/tenancy";
import { explorerTxUrl } from "./lib/x402/money";

/**
 * Rounds: start -> price -> offer -> deal, then pay -> play. One round sells
 * the spot on air now on one screen. Every invited company gets the same
 * offer (floor x signals) and deals with the host alone: accept, counter
 * (the host counters once, halfway; a second offer at or above the floor is
 * a deal) or pass. Companies never see or compete with each other's offers:
 * the first deal takes the spot. Every round ends with an outcome sentence.
 */

const BUCKET_MS = 15 * 60_000;
const MAX_KEYS_SCANNED = 20;
const NO_INVITES = "No company agents with an approved ad and budget.";
const SOLD_ELSEWHERE = "Spot was sold elsewhere.";
const ROUND_HOLD_TTL_MS = 3 * 60_000;
/** While a payment is settling at the pay deadline, look again this much later (within the hold's TTL). */
const PAY_RECHECK_MS = 20_000;
/** A round still "bidding" this long past its close never got closed (its scheduled close failed). */
const STALE_GRACE_MS = 10_000;
const MAX_AUTO_WORKSPACES = 50;
const MAX_AUTO_SCREENS = 20;

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

async function latestRound(ctx: QueryCtx, billboardId: Id<"billboards">): Promise<Doc<"rounds"> | null> {
  return await ctx.db
    .query("rounds")
    .withIndex("by_billboard_and_createdAt", (q) => q.eq("billboardId", billboardId))
    .order("desc")
    .first();
}

async function bidsOf(ctx: QueryCtx, roundId: Id<"rounds">): Promise<Doc<"roundBids">[]> {
  return await ctx.db
    .query("roundBids")
    .withIndex("by_round", (q) => q.eq("roundId", roundId))
    .take(MAX_INVITES);
}

async function companyName(ctx: QueryCtx, advertiserId: Id<"advertisers">): Promise<string> {
  return (await ctx.db.get(advertiserId))?.displayName ?? "A company";
}

/** The slot playing right now on this screen, if any. */
async function currentSlot(ctx: QueryCtx, billboardId: Id<"billboards">, now: number): Promise<Doc<"slots"> | null> {
  const slots = await ctx.db
    .query("slots")
    .withIndex("by_billboard_and_startAt", (q) => q.eq("billboardId", billboardId).gt("startAt", now - BUCKET_MS).lte("startAt", now))
    .take(2);
  return slots.find((s) => s.endAt > now) ?? null;
}

/**
 * The spot on air now: the rest of the current slot when it has >= 3 min
 * left. A current slot that's already sold means no round (never interrupt
 * a paid ad). Only when there's no current slot (a new screen's inventory
 * starts at the next quarter hour) or it's nearly over, the next slot if it
 * starts within one slot length. The autopilot hands over slots under 15
 * min out, so rounds and forward offers never overlap.
 */
async function onAirSpot(ctx: QueryCtx, billboardId: Id<"billboards">, now: number): Promise<Doc<"slots"> | null> {
  const free = async (s: Doc<"slots">) => s.state === "available";
  const current = await currentSlot(ctx, billboardId, now);
  if (current && current.endAt - now >= MIN_REMAINING_MS) return (await free(current)) ? current : null;
  const next = await ctx.db
    .query("slots")
    .withIndex("by_billboard_and_startAt", (q) => q.eq("billboardId", billboardId).gt("startAt", now).lte("startAt", now + BUCKET_MS))
    .first();
  return next && (await free(next)) ? next : null;
}

/** People in view in the screen's current 15-minute camera bucket, or null without a reading. */
async function crowdNow(ctx: QueryCtx, billboardId: Id<"billboards">, now: number): Promise<number | null> {
  const bucketStart = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const rows = await ctx.db
    .query("audienceAggregates")
    .withIndex("by_billboard_and_bucketStart", (q) => q.eq("billboardId", billboardId).eq("bucketStart", bucketStart))
    .take(4);
  const row = rows.find((r) => r.source === "camera");
  return row ? (row.peakInView ?? null) : null;
}

type Invite = { advertiserId: Id<"advertisers">; campaign: Doc<"campaigns">; key: Doc<"agentKeys">; match: number | null; companyFactor: number };

/** A key that can take part: active, webhook, bid + pay scopes, allowed for the campaign. */
function canBid(k: Doc<"agentKeys">, campaignId: Id<"campaigns">, now: number): boolean {
  if (keyStatus(k, now) !== "active" || !k.webhookUrl) return false;
  if (!k.scopes.includes("bid") || !k.scopes.includes("pay")) return false;
  return !k.campaignIds || k.campaignIds.includes(campaignId);
}

/**
 * Who gets an offer: a company with an ad ready on this host, an agent key
 * that can bid and pay, budget left, and buyers in this crowd (its research
 * audience matches the screen's audience read by at least MIN_MATCH; when
 * either isn't known yet, it's offered). One key and one campaign per
 * company: the built-in agent's first, else the newest that qualify.
 */
async function invitees(ctx: QueryCtx, billboard: Doc<"billboards">, workspaceId: Id<"workspaces">, now: number): Promise<{ invites: Invite[]; notMatching: string[] }> {
  const ready = new Map<Id<"advertisers">, Doc<"campaigns">[]>();
  for (const c of await campaignsReadyFor(ctx, workspaceId)) ready.set(c.advertiserId, [...(ready.get(c.advertiserId) ?? []), c]);
  const out: Invite[] = [];
  const notMatching: string[] = [];
  for (const [advertiserId, campaigns] of ready) {
    if (out.length >= MAX_INVITES) break;
    campaigns.sort((a, b) => b._creationTime - a._creationTime);
    const agent = await ctx.db
      .query("companyAgents")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
      .first();
    let pick: Invite | null = null;
    if (agent?.enabled) {
      const key = await ctx.db.get(agent.agentKeyId);
      const campaign = campaigns.find((c) => c._id === agent.campaignId) ?? campaigns.find((c) => key && canBid(key, c._id, now));
      if (key && campaign && canBid(key, campaign._id, now)) pick = { advertiserId, campaign, key, match: null, companyFactor: 1 };
    }
    if (!pick) {
      const keys = await ctx.db
        .query("agentKeys")
        .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
        .order("desc")
        .take(MAX_KEYS_SCANNED);
      for (const key of keys) {
        const campaign = campaigns.find((c) => canBid(key, c._id, now));
        if (campaign) {
          pick = { advertiserId, campaign, key, match: null, companyFactor: 1 };
          break;
        }
      }
    }
    if (!pick) continue;
    const standing = pick.key.standing;
    if (standing && standing.dailyBudgetMinor - (await spentTodayForAdvertiserMinor(ctx, advertiserId, now)) <= 0) continue;
    const research = await researchOf(ctx, advertiserId);
    const match = matchScore(billboard.audienceTags, research?.audienceTags ?? pick.campaign.targetAudience);
    if (match !== null && match < MIN_MATCH) {
      notMatching.push(`${await companyName(ctx, advertiserId)} (${Math.round(match * 100)}% match)`);
      continue;
    }
    out.push({ ...pick, match, companyFactor: research?.priceFactor ?? 1 });
  }
  return { invites: out, notMatching };
}

/** Paid sales on this screen in the last 2 hours (the demand signal). */
async function recentSales(ctx: QueryCtx, billboardId: Id<"billboards">, now: number): Promise<number> {
  const rounds = await ctx.db
    .query("rounds")
    .withIndex("by_billboard_and_createdAt", (q) => q.eq("billboardId", billboardId).gte("createdAt", now - 2 * 60 * 60_000))
    .take(50);
  return rounds.filter((r) => r.status === "paid").length;
}

/**
 * A round left open by a close or pay deadline that never ran ends now, so it
 * can't block the screen: past its close -> closed; awarded with its hold gone
 * or expired -> the winner defaults. Returns the screen's latest round after.
 */
async function clearStale(ctx: MutationCtx, billboardId: Id<"billboards">, now: number): Promise<Doc<"rounds"> | null> {
  const last = await latestRound(ctx, billboardId);
  if (!last) return null;
  if (last.status === "bidding" && now > last.closesAt + STALE_GRACE_MS) {
    await closeRoundCore(ctx, last._id);
  } else if (last.status === "awarded") {
    const hold = last.holdId ? await ctx.db.get(last.holdId) : null;
    if (!hold || hold.status === "released" || hold.status === "expired" || (hold.status === "active" && hold.expiresAt < now)) {
      await defaultWinner(ctx, last, last.holdId!, "its hold expired before payment");
    }
  }
  return await ctx.db.get(last._id);
}

/**
 * Start a round on a screen (every trigger calls this). Null when the
 * screen has a round open, the camera is cooling down, or nothing is on air
 * to sell. With nobody to invite, the round ends unsold at once.
 */
export async function startRoundCore(
  ctx: MutationCtx,
  billboardId: Id<"billboards">,
  trigger: Infer<typeof roundTrigger>,
): Promise<Id<"rounds"> | null> {
  const now = Date.now();
  const billboard = await ctx.db.get(billboardId);
  if (!billboard?.workspaceId) return null;
  const last = await clearStale(ctx, billboardId, now);
  if (last && (last.status === "bidding" || last.status === "awarded")) return null;
  if (trigger === "camera" && last && now - (last.closedAt ?? last.createdAt) < CAMERA_COOLDOWN_MS) return null;
  const spot = await onAirSpot(ctx, billboardId, now);
  if (!spot) return null;

  const crowd = await crowdNow(ctx, billboardId, now);
  const event = await activeEvent(ctx, billboardId, now);
  const signals = priceSignals({
    peakInView: crowd,
    usualInView: billboard.usualInView,
    eventName: event?.name ?? null,
    recentSales: await recentSales(ctx, billboardId, now),
  });
  const floorMinor = billboard.reserveFloorMinor;
  const askingMinor = askingPrice(floorMinor, signals);
  const { invites, notMatching } = await invitees(ctx, billboard, billboard.workspaceId, now);

  const roundId = await ctx.db.insert("rounds", {
    workspaceId: billboard.workspaceId,
    billboardId,
    slotId: spot._id,
    spotStartAt: Math.max(now, spot.startAt),
    spotEndAt: spot.endAt,
    trigger,
    status: "bidding",
    floorMinor,
    askingMinor,
    signals,
    crowd,
    eventName: event?.name ?? null,
    invitedCount: invites.length,
    closesAt: now + ROUND_CLOSE_MS,
    createdAt: now,
  });
  for (const i of invites) {
    const bidId = await ctx.db.insert("roundBids", {
      roundId,
      advertiserId: i.advertiserId,
      campaignId: i.campaign._id,
      agentKeyId: i.key._id,
      match: i.match,
      companyFactor: i.companyFactor,
      offerMinor: companyOffer(askingMinor, floorMinor, i.companyFactor),
      amountMinor: null,
      status: "invited",
    });
    await ctx.scheduler.runAfter(0, internal.roundDelivery.deliver, { bidId, event: "round_offer" });
  }
  await recordAudit(ctx, {
    workspaceId: billboard.workspaceId,
    traceId: `round:${roundId}`,
    actor: `seller-agent:${billboard.name}`,
    type: "round.started",
    subjectId: roundId,
    reason: `Round on ${billboard.name} (${trigger}): floor ${usd(floorMinor)}, price ${usd(askingMinor)} x each company's factor, to ${invites.length}${notMatching.length ? `; not offered: ${notMatching.join(", ")}` : ""}`,
  });
  if (invites.length === 0) {
    const outcome = notMatching.length
      ? `No company's buyers are in this crowd${billboard.audienceSummary ? ` (${billboard.audienceSummary})` : ""}. Not offered: ${notMatching.join(", ")}.`
      : NO_INVITES;
    await endUnsold(ctx, (await ctx.db.get(roundId))!, outcome);
    return roundId;
  }
  await ctx.scheduler.runAt(now + ROUND_CLOSE_MS, internal.rounds.closeRound, { roundId });
  return roundId;
}

async function endUnsold(ctx: MutationCtx, round: Doc<"rounds">, outcome: string): Promise<void> {
  await ctx.db.patch(round._id, { status: "unsold", closedAt: Date.now(), outcome });
  await recordAudit(ctx, {
    workspaceId: round.workspaceId,
    traceId: `round:${round._id}`,
    actor: "seller-agent",
    type: "round.unsold",
    subjectId: round._id,
    reason: outcome,
  });
}

/** One company's answer, for the outcome sentence. */
function answerOf(b: Doc<"roundBids">): string {
  if (b.status === "passed") return b.reasoning ?? "passed";
  if (b.amountMinor !== null) return `offered ${usd(b.amountMinor)}, host asked ${usd(b.offerMinor ?? 0)}`;
  return "no answer";
}

/**
 * Close a round with no deal (idempotent: only a round still bidding
 * changes): everyone passed, or the deadline came first. Unsold, with each
 * company's last answer.
 */
export async function closeRoundCore(ctx: MutationCtx, roundId: Id<"rounds">): Promise<void> {
  const round = await ctx.db.get(roundId);
  if (!round || round.status !== "bidding") return;
  const reasons = [];
  for (const b of await bidsOf(ctx, roundId)) reasons.push(`${await companyName(ctx, b.advertiserId)}: ${answerOf(b)}`);
  await endUnsold(ctx, round, `Unsold: no deal at or above the ${usd(round.floorMinor)} floor. ${reasons.join("; ")}.`);
}

/**
 * The deal: a quote and a hold for the rest of the spot at the agreed price,
 * the company told to pay (round_won) within 60 s, every other company told
 * the spot is gone. "skip" when this key can't buy any more; "ended" when
 * the spot itself is gone (the round ends unsold).
 */
export async function awardCore(
  ctx: MutationCtx,
  round: Doc<"rounds">,
  bidId: Id<"roundBids">,
  priceMinor: number,
  outcome: string,
): Promise<"awarded" | "skip" | "ended"> {
  const bid = (await ctx.db.get(bidId))!;
  const key = await ctx.db.get(bid.agentKeyId);
  const now = Date.now();
  if (!key || keyStatus(key, now) !== "active") return "skip";
  try {
    await assertWithinBudget(ctx, key, priceMinor);
  } catch {
    return "skip";
  }
  const company = await companyName(ctx, bid.advertiserId);
  const billboard = await ctx.db.get(round.billboardId);
  const quoteId = await ctx.db.insert("quotes", {
    workspaceId: round.workspaceId,
    campaignId: bid.campaignId,
    billboardId: round.billboardId,
    slotIds: [round.slotId],
    amountMinor: priceMinor,
    currency: "USD",
    expiresAt: now + 10 * 60_000,
    pricingBasis: [
      `Round on ${billboard?.name ?? "screen"}: floor ${usd(round.floorMinor)}, offered at ${usd(round.askingMinor)}, deal at ${usd(priceMinor)}`,
      ...round.signals.map((sig) => sig.reason),
    ],
    confidence: "medium",
    policyVersion: PRICING_POLICY_VERSION,
    status: "open",
    traceId: `round:${round._id}`,
    agentKeyId: key._id,
    screenAmountMinor: round.askingMinor,
  });
  let holdId: Id<"holds">;
  try {
    const hold = await takeHold(ctx, (await ctx.db.get(quoteId))!, `round:${round._id}:${bidId}`, `agent:${company}/${key.name}`, {
      agentKeyId: key._id,
      inProgressMinRemainingMs: 60_000,
      ttlMs: ROUND_HOLD_TTL_MS,
    });
    holdId = hold._id;
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    // The spot can't be held any more: end the round with the reason (never leave the screen stuck in a round).
    await ctx.db.patch(quoteId, { status: "expired" });
    const data = error.data as { code?: string; message?: string };
    const why =
      data.code === "SLOT_UNAVAILABLE" ? SOLD_ELSEWHERE : `Couldn't hold the spot: ${data.message ?? data.code ?? "unknown error"}.`;
    await endUnsold(ctx, round, why);
    return "ended";
  }
  await ctx.db.patch(round._id, {
    status: "awarded",
    winnerBidId: bidId,
    priceMinor,
    closedAt: Date.now(),
    holdId,
    outcome,
  });
  for (const b of await bidsOf(ctx, round._id)) {
    if (b._id === bidId) {
      await ctx.db.patch(b._id, { status: "won" });
      await ctx.scheduler.runAfter(0, internal.roundDelivery.deliver, { bidId: b._id, event: "round_won" });
    } else if (b.status === "bid" || b.status === "invited") {
      await ctx.db.patch(b._id, { status: "lost" });
      await ctx.scheduler.runAfter(0, internal.roundDelivery.deliver, { bidId: b._id, event: "round_lost" });
    }
  }
  await recordAudit(ctx, {
    workspaceId: round.workspaceId,
    traceId: `round:${round._id}`,
    actor: `seller-agent:${billboard?.name ?? "screen"}`,
    type: "round.awarded",
    subjectId: round._id,
    reason: `${outcome} Hold ${holdId}; pay within ${PAY_WINDOW_MS / 1000} s.`,
  });
  await ctx.scheduler.runAfter(PAY_WINDOW_MS, internal.rounds.payDeadline, { roundId: round._id, holdId });
  return "awarded";
}

/** The company didn't pay: release its hold, mark it defaulted, and end the round unsold (the next round offers the spot again). */
async function defaultWinner(ctx: MutationCtx, round: Doc<"rounds">, holdId: Id<"holds">, reason: string): Promise<void> {
  const hold = await ctx.db.get(holdId);
  if (hold?.status === "active") await endHold(ctx, hold, "released", "system", `Round winner didn't pay: ${reason}`);
  const winner = round.winnerBidId ? await ctx.db.get(round.winnerBidId) : null;
  if (winner) await ctx.db.patch(winner._id, { status: "defaulted" });
  const who = winner ? await companyName(ctx, winner.advertiserId) : "The winner";
  await ctx.db.patch(round._id, { holdId: undefined, winnerBidId: undefined });
  await endUnsold(ctx, round, `Payment failed: ${who}'s payment failed: ${reason}.`);
}

/** The winner's payment was blocked (e.g. empty wallet, no CDP keys). Idempotent per hold. */
export const paymentFailed = internalMutation({
  args: { holdId: v.id("holds"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const round = await ctx.db
      .query("rounds")
      .withIndex("by_hold", (q) => q.eq("holdId", args.holdId))
      .first();
    if (!round || round.status !== "awarded") return null;
    await defaultWinner(ctx, round, args.holdId, args.reason.slice(0, 200));
    return null;
  },
});

/** 60 s after the deal: paid -> nothing; a payment settling -> look again; otherwise unsold. */
export const payDeadline = internalMutation({
  args: { roundId: v.id("rounds"), holdId: v.id("holds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const round = await ctx.db.get(args.roundId);
    if (!round || round.status !== "awarded" || round.holdId !== args.holdId) return null;
    const hold = await ctx.db.get(args.holdId);
    if (!hold || hold.status === "converted") return null;
    const now = Date.now();
    if (hold.status === "active" && hold.expiresAt > now && (await lockHeld(ctx, holdLockKey(hold._id), now))) {
      await ctx.scheduler.runAfter(PAY_RECHECK_MS, internal.rounds.payDeadline, args);
      return null;
    }
    await defaultWinner(ctx, round, args.holdId, `not paid within ${PAY_WINDOW_MS / 1000} s`);
    return null;
  },
});

export const closeRound = internalMutation({
  args: { roundId: v.id("rounds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await closeRoundCore(ctx, args.roundId);
    return null;
  },
});

/**
 * An invited company's answer (POST /api/agent/rounds/{id}/bid), dealt with
 * on its own: `amountMinor` at or above the host's price to it is a deal at
 * that price; between the floor and that price, the host counters once
 * (round_counter) and a second offer is a deal; null passes. The first deal
 * takes the spot; everyone else is told it's gone.
 */
export const submitBid = internalMutation({
  args: { token: v.string(), roundId: v.string(), amountMinor: v.union(v.number(), v.null()), reasoning: v.optional(v.string()) },
  returns: v.object({
    status: v.union(v.literal("deal"), v.literal("countered"), v.literal("passed"), v.literal("unavailable")),
    priceMinor: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "bid");
    const roundId = ctx.db.normalizeId("rounds", args.roundId);
    const round = roundId ? await ctx.db.get(roundId) : null;
    if (!round) fail("NOT_FOUND", "Round not found");
    const row = await ctx.db
      .query("roundBids")
      .withIndex("by_advertiser_and_round", (q) => q.eq("advertiserId", agent.key.advertiserId).eq("roundId", round._id))
      .first();
    if (!row || row.agentKeyId !== agent.key._id) fail("NOT_INVITED", "This key wasn't invited to this round");
    const now = Date.now();
    if (round.status !== "bidding" || now > round.closesAt) fail("ROUND_CLOSED", "This spot is no longer for sale");
    if (row.status !== "invited") fail("ALREADY_ANSWERED", "You already passed on this spot");
    const reasoning = args.reasoning?.slice(0, 300);
    if (args.amountMinor === null) {
      await ctx.db.patch(row._id, { status: "passed", reasoning, answeredAt: now });
      if ((await bidsOf(ctx, round._id)).every((b) => b.status !== "invited")) await closeRoundCore(ctx, round._id);
      return { status: "passed" as const, priceMinor: null };
    }
    const amount = args.amountMinor;
    if (!Number.isSafeInteger(amount) || amount <= 0) fail("INVALID_INPUT", "amountMinor must be whole cents above 0, or null to pass");
    if (amount < round.floorMinor) fail("BELOW_FLOOR", `Offers start at the ${usd(round.floorMinor)} floor`);
    const over = replyAllowed(agent.key.standing, amount, await spentTodayForAdvertiserMinor(ctx, agent.key.advertiserId, now));
    if (over) fail("OVER_LIMIT", `Offer is ${over}`);
    try {
      await assertWithinBudget(ctx, agent.key, amount);
    } catch {
      fail("OVER_LIMIT", "Offer is over this key's budget cap");
    }
    const reply = hostReply({ amountMinor: amount, priceMinor: row.offerMinor ?? round.askingMinor, countered: row.countered === true });
    if (reply.kind === "counter") {
      await ctx.db.patch(row._id, { amountMinor: amount, offerMinor: reply.priceMinor, countered: true, reasoning, answeredAt: now });
      await ctx.scheduler.runAfter(0, internal.roundDelivery.deliver, { bidId: row._id, event: "round_counter" });
      return { status: "countered" as const, priceMinor: reply.priceMinor };
    }
    await ctx.db.patch(row._id, { amountMinor: amount, reasoning, answeredAt: now, status: "bid" });
    const company = await companyName(ctx, row.advertiserId);
    const outcome = `${company} took the spot at ${usd(reply.priceMinor)}${row.countered ? " after a counter" : ""}.`;
    const result = await awardCore(ctx, round, row._id, reply.priceMinor, outcome);
    if (result === "skip") fail("OVER_LIMIT", "This key can no longer buy");
    if (result === "ended") return { status: "unavailable" as const, priceMinor: null };
    return { status: "deal" as const, priceMinor: reply.priceMinor };
  },
});

// ---------------------------------------------------------------- triggers

/**
 * Camera arrivals and a live event start a round through here. Scheduled
 * (not called inline) so the round prices on the reading that was just saved.
 */
export const trigger = internalMutation({
  args: { billboardId: v.id("billboards"), trigger: roundTrigger },
  returns: v.null(),
  handler: async (ctx, args) => {
    await startRoundCore(ctx, args.billboardId, args.trigger);
    return null;
  },
});

/** The host's "Sell now": start a round on this screen right away (no camera cooldown). */
export const sellNow = mutation({
  args: { billboardId: v.id("billboards") },
  returns: v.object({ roundId: v.union(v.id("rounds"), v.null()), reason: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
    const now = Date.now();
    const last = await clearStale(ctx, args.billboardId, now);
    if (last && (last.status === "bidding" || last.status === "awarded")) {
      return { roundId: null, reason: "A round is already running on this screen." };
    }
    const roundId = await startRoundCore(ctx, args.billboardId, "sell_now");
    if (roundId) return { roundId, reason: null };
    const current = await currentSlot(ctx, args.billboardId, now);
    return {
      roundId: null,
      reason:
        current && current.state !== "available" && current.endAt - now >= MIN_REMAINING_MS
          ? "The spot on air is already sold."
          : "Nothing on air to sell: the current spot ends in under 3 minutes and the next one isn't free.",
    };
  },
});

/** Turn "auto-sell when idle" on or off for the workspace (on by default; each company's daily budget caps what it spends). */
export const setAutoSell = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    await requireWorkspaceMember(ctx, me.workspaceId);
    await ctx.db.patch(me.workspaceId, { autoSellRounds: args.enabled });
    return null;
  },
});

/** Every minute: unless the host turned auto-sell off, a round on each online screen whose spot on air is unsold (at most one per 2 minutes). */
export const autoSellTick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const workspaces = await ctx.db.query("workspaces").take(MAX_AUTO_WORKSPACES * 4);
    for (const ws of workspaces.filter((w) => w.autoSellRounds !== false).slice(0, MAX_AUTO_WORKSPACES)) {
      const screens = await ctx.db
        .query("billboards")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id))
        .take(MAX_AUTO_SCREENS);
      for (const screen of screens) {
        if (screen.deviceStatus !== "online" || !screen.deviceId) continue;
        const last = await latestRound(ctx, screen._id);
        if (last && now - last.createdAt < AUTO_SELL_GAP_MS) continue;
        await startRoundCore(ctx, screen._id, "timer");
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------- what people see

const roundView = v.object({
  roundId: v.id("rounds"),
  status: roundStatus,
  trigger: roundTrigger,
  floorMinor: v.number(),
  askingMinor: v.number(),
  signals: v.array(priceSignal),
  crowd: v.union(v.number(), v.null()),
  closesAt: v.number(),
  spotEndAt: v.number(),
  createdAt: v.number(),
  priceMinor: v.union(v.number(), v.null()),
  outcome: v.union(v.string(), v.null()),
  txUrl: v.union(v.string(), v.null()),
  bids: v.array(
    v.object({
      company: v.string(),
      amountMinor: v.union(v.number(), v.null()),
      reasoning: v.union(v.string(), v.null()),
      offerMinor: v.union(v.number(), v.null()),
      match: v.union(v.number(), v.null()),
      companyFactor: v.union(v.number(), v.null()),
      status: roundBidStatus,
    }),
  ),
});

async function toView(ctx: QueryCtx, round: Doc<"rounds">) {
  const bids = [];
  for (const b of await bidsOf(ctx, round._id)) {
    bids.push({
      company: await companyName(ctx, b.advertiserId),
      amountMinor: b.amountMinor,
      reasoning: b.reasoning ?? null,
      offerMinor: b.offerMinor ?? null,
      match: b.match,
      companyFactor: b.companyFactor ?? null,
      status: b.status,
    });
  }
  return {
    roundId: round._id,
    status: round.status,
    trigger: round.trigger,
    floorMinor: round.floorMinor,
    askingMinor: round.askingMinor,
    signals: round.signals,
    crowd: round.crowd,
    closesAt: round.closesAt,
    spotEndAt: round.spotEndAt,
    createdAt: round.createdAt,
    priceMinor: round.priceMinor ?? null,
    outcome: round.outcome ?? null,
    txUrl: round.paymentTx && round.paymentNetwork ? (explorerTxUrl(round.paymentNetwork, round.paymentTx) ?? null) : null,
    bids,
  };
}

/** Presenter page: every screen of the workspace with its latest round, and the auto-sell switch. */
export const live = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({
    autoSell: v.boolean(),
    screens: v.array(v.object({ billboardId: v.id("billboards"), name: v.string(), online: v.boolean(), round: v.union(roundView, v.null()) })),
  }),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    await requireWorkspaceMember(ctx, me.workspaceId);
    const workspace = await ctx.db.get(me.workspaceId);
    const screens = await ctx.db
      .query("billboards")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .take(MAX_AUTO_SCREENS);
    const out = [];
    for (const s of screens) {
      const round = await latestRound(ctx, s._id);
      out.push({ billboardId: s._id, name: s.name, online: s.deviceStatus === "online", round: round ? await toView(ctx, round) : null });
    }
    return { autoSell: workspace?.autoSellRounds !== false, screens: out };
  },
});

/** Advertiser feed: the rounds this company was invited to, newest first. */
export const myRounds = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      roundId: v.id("rounds"),
      screen: v.string(),
      roundStatus: roundStatus,
      outcome: v.union(v.string(), v.null()),
      amountMinor: v.union(v.number(), v.null()),
      /** The host's price to this company (its own, after the research factor and any counter). */
      offerMinor: v.union(v.number(), v.null()),
      reasoning: v.union(v.string(), v.null()),
      bidStatus: roundBidStatus,
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx);
    const rows = await ctx.db
      .query("roundBids")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(Math.min(Math.max(1, Math.floor(args.limit ?? 10)), 10));
    const out = [];
    for (const b of rows) {
      const round = await ctx.db.get(b.roundId);
      if (!round) continue;
      out.push({
        roundId: round._id,
        screen: (await ctx.db.get(round.billboardId))?.name ?? "Screen",
        roundStatus: round.status,
        outcome: round.outcome ?? null,
        amountMinor: b.amountMinor,
        offerMinor: b.offerMinor ?? null,
        reasoning: b.reasoning ?? null,
        bidStatus: b.status,
        createdAt: round.createdAt,
      });
    }
    return out;
  },
});
