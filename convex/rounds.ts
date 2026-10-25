import { ConvexError, v, type Infer } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { priceSignal, roundBidStatus, roundStatus, roundTrigger } from "./schemaParts/rounds";
import { recordAudit } from "./lib/audit";
import { assertWithinBudget, authenticateAgent, keyStatus } from "./lib/agentKeys";
import { holdLockKey, lockHeld } from "./lib/paymentLock";
import { endHold, takeHold } from "./holds";
import { MAX_INVITES, MIN_MATCH, WINDOW_MS, bestAgreed, brandScore, hostReply, windowPrice } from "./lib/rounds";
import { applyOutcome, isCooled, outcomeFromBidStatus, rankTopInvites } from "./lib/inviteRoster";
import { matchScore } from "./lib/match";
import { researchOf } from "./research";
import { peopleNow, predictFor, recordWindow, weightsOf } from "./pricing";
import { PRICING_POLICY_VERSION, activeEvent, campaignsReadyFor, replyAllowed, spentTodayForAdvertiserMinor } from "./lib/sale";
import { requireCustomer, requireWorkspaceMember, resolveWorkspace, workspaceOfBillboard } from "./lib/tenancy";
import { explorerTxUrl } from "./lib/x402/money";

/**
 * Rounds: each screen runs back-to-back 30-second windows. While window N
 * plays, the round for window N+1 runs:
 *   start -> price each company -> offer -> two turns each -> close -> pay -> play
 * Every invited company gets its own price (a x predicted + b x people +
 * c x brand, clamped to [floor, cap]) and deals with the host alone: it
 * accepts, counters (the host counters once, halfway) or passes, and its
 * second answer is final. When the 30 seconds are up the highest agreed price
 * wins; nobody agreed -> our own house ad plays that window. Closing starts
 * the next round right away, so the screen never waits. Every move is saved
 * (negotiationSteps, priceWindows) for the price model.
 */

const MAX_KEYS_SCANNED = 20;
const NO_INVITES = "No company agents with an approved ad, budget and buyers in this crowd.";
const SOLD_ELSEWHERE = "Window was sold elsewhere.";
const HOLD_TTL_MS = 2 * 60_000;
/** The winner pays within the first part of its window; a payment still settling then gets one more look. */
const PAY_DEADLINE_MS = 20_000;
const PAY_RECHECK_MS = 10_000;
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

async function step(
  ctx: MutationCtx,
  round: Doc<"rounds">,
  advertiserId: Id<"advertisers">,
  actor: "host" | "company",
  kind: "offer" | "counter" | "accept" | "pass",
  amountMinor: number | null,
  reasoning?: string,
): Promise<void> {
  await ctx.db.insert("negotiationSteps", { roundId: round._id, billboardId: round.billboardId, advertiserId, actor, kind, amountMinor, reasoning, at: Date.now() });
}

type Invite = { advertiserId: Id<"advertisers">; campaign: Doc<"campaigns">; key: Doc<"agentKeys">; match: number | null; brand: number };

/** A key that can take part: active, webhook, bid + pay scopes, allowed for the campaign. */
function canBid(k: Doc<"agentKeys">, campaignId: Id<"campaigns">, now: number): boolean {
  if (keyStatus(k, now) !== "active" || !k.webhookUrl) return false;
  if (!k.scopes.includes("bid") || !k.scopes.includes("pay")) return false;
  return !k.campaignIds || k.campaignIds.includes(campaignId);
}

/**
 * Who gets an offer from the full sponsor network: ready ad + agent that can
 * bid/pay + budget left, not cooled-down on this billboard. Rank by vibe
 * match (screen audience × company tags) and optional Invite CREAO prefs;
 * invite only the top MAX_INVITES. CREAO is never called here.
 */
async function invitees(ctx: QueryCtx, billboard: Doc<"billboards">, workspaceId: Id<"workspaces">, now: number): Promise<{ invites: Invite[]; notMatching: string[] }> {
  const ready = new Map<Id<"advertisers">, Doc<"campaigns">[]>();
  for (const c of await campaignsReadyFor(ctx, workspaceId)) ready.set(c.advertiserId, [...(ready.get(c.advertiserId) ?? []), c]);

  const prefs = await ctx.db
    .query("billboardInvitePrefs")
    .withIndex("by_billboard", (q) => q.eq("billboardId", billboard._id))
    .take(200);
  const prefByAdv = new Map(prefs.map((p) => [p.advertiserId, p.weight]));

  const stats = await ctx.db
    .query("inviteStats")
    .withIndex("by_billboard", (q) => q.eq("billboardId", billboard._id))
    .take(200);
  const statByAdv = new Map(stats.map((s) => [s.advertiserId, s]));

  const eligible: Array<Invite & { prefWeight: number }> = [];
  const notMatching: string[] = [];
  const cooled: string[] = [];

  for (const [advertiserId, campaigns] of ready) {
    const stat = statByAdv.get(advertiserId);
    if (isCooled(stat, now)) {
      cooled.push(await companyName(ctx, advertiserId));
      continue;
    }
    campaigns.sort((a, b) => b._creationTime - a._creationTime);
    const agent = await ctx.db
      .query("companyAgents")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
      .first();
    let pick: Omit<Invite, "match" | "brand"> | null = null;
    if (agent?.enabled) {
      const key = await ctx.db.get(agent.agentKeyId);
      const campaign = campaigns.find((c) => c._id === agent.campaignId) ?? campaigns.find((c) => key && canBid(key, c._id, now));
      if (key && campaign && canBid(key, campaign._id, now)) pick = { advertiserId, campaign, key };
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
          pick = { advertiserId, campaign, key };
          break;
        }
      }
    }
    if (!pick) continue;
    const standing = pick.key.standing;
    if (standing && standing.dailyBudgetMinor - (await spentTodayForAdvertiserMinor(ctx, advertiserId, now)) <= 0) continue;
    const research = await researchOf(ctx, advertiserId);
    const match = matchScore(billboard.audienceTags, research?.audienceTags ?? pick.campaign.targetAudience);
    // Known mismatch stays out of the active set (null match still invited — audience unread).
    if (match !== null && match < MIN_MATCH) {
      notMatching.push(`${await companyName(ctx, advertiserId)} (${Math.round(match * 100)}% match)`);
      continue;
    }
    eligible.push({
      ...pick,
      match,
      brand: brandScore(research?.priceFactor ?? 1),
      prefWeight: prefByAdv.get(advertiserId) ?? 0,
    });
  }

  const ranked = rankTopInvites(eligible, MAX_INVITES);
  const invites: Invite[] = ranked.map(({ prefWeight: _p, ...rest }) => rest);
  if (cooled.length) {
    notMatching.push(`cooled down: ${cooled.join(", ")}`);
  }
  return { invites, notMatching };
}

/** After a round closes: update reject streaks / cool-downs; schedule Invite CREAO when someone cools. */
async function recordInviteOutcomes(
  ctx: MutationCtx,
  billboardId: Id<"billboards">,
  workspaceId: Id<"workspaces">,
  bids: Doc<"roundBids">[],
  winnerBidId: Id<"roundBids"> | undefined,
  now: number,
): Promise<void> {
  let cooledSomeone = false;
  for (const b of bids) {
    // Losers who had agreed a price are patched to "lost" but still count as success for streaks.
    const agreed =
      b._id === winnerBidId ||
      b.status === "bid" ||
      b.status === "won" ||
      b.agreedAt !== undefined;
    const outcome = outcomeFromBidStatus(b.status, agreed);
    const existing = await ctx.db
      .query("inviteStats")
      .withIndex("by_billboard_and_advertiser", (q) => q.eq("billboardId", billboardId).eq("advertiserId", b.advertiserId))
      .first();
    const next = applyOutcome(existing ?? undefined, outcome, now);
    const justCooled = typeof next.cooledUntilAt === "number" && next.cooledUntilAt > now && existing?.cooledUntilAt !== next.cooledUntilAt;
    if (justCooled) cooledSomeone = true;
    if (existing) {
      await ctx.db.patch(existing._id, { ...next, lastOutcome: outcome, updatedAt: now });
    } else {
      await ctx.db.insert("inviteStats", {
        billboardId,
        advertiserId: b.advertiserId,
        rejectStreak: next.rejectStreak,
        cooledUntilAt: next.cooledUntilAt,
        lastOutcome: outcome,
        updatedAt: now,
      });
    }
    if (justCooled) {
      await recordAudit(ctx, {
        traceId: `round:${b.roundId}`,
        actor: "invite-roster",
        type: "invite.cooled",
        subjectId: billboardId,
        reason: `${await companyName(ctx, b.advertiserId)} cooled down after ${next.rejectStreak} price rejects on this screen`,
      });
    }
  }
  if (cooledSomeone || bids.length < MAX_INVITES) {
    await ctx.scheduler.runAfter(0, internal.inviteHarness.onRosterHole, { billboardId, workspaceId });
  }
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
 * Start the round for the next window on a screen (every trigger and every
 * close calls this). Null when a round is already bidding there, or the
 * screen is retired or unassigned. The round always closes at its deadline,
 * even with nobody to invite, so the 30-second loop keeps its beat.
 */
export async function startRoundCore(
  ctx: MutationCtx,
  billboardId: Id<"billboards">,
  trigger: Infer<typeof roundTrigger>,
): Promise<Id<"rounds"> | null> {
  const now = Date.now();
  const billboard = await ctx.db.get(billboardId);
  if (!billboard?.workspaceId || billboard.retiredAt !== undefined) return null;
  const last = await clearStale(ctx, billboardId, now);
  if (last?.status === "bidding") return null;

  const closesAt = now + WINDOW_MS;
  const people = await peopleNow(ctx, billboard, now);
  const event = await activeEvent(ctx, billboardId, now);
  const { predictedMinor, modelId } = await predictFor(ctx, billboard, closesAt, people);
  const w = weightsOf(billboard);
  const floorMinor = billboard.reserveFloorMinor;
  const base = windowPrice({ predictedMinor, people, brand: 0, floorMinor, w });
  const { invites, notMatching } = await invitees(ctx, billboard, billboard.workspaceId, now);

  const roundId = await ctx.db.insert("rounds", {
    workspaceId: billboard.workspaceId,
    billboardId,
    spotStartAt: closesAt,
    spotEndAt: closesAt + WINDOW_MS,
    trigger,
    status: "bidding",
    floorMinor,
    askingMinor: base.priceMinor,
    signals: [],
    crowd: people,
    eventName: event?.name ?? null,
    invitedCount: invites.length,
    closesAt,
    createdAt: now,
    pricing: { predictedMinor, modelId, people, ...w },
    outcome: invites.length === 0 ? NO_INVITES + (notMatching.length ? ` Not offered: ${notMatching.join(", ")}.` : "") : undefined,
  });
  const round = (await ctx.db.get(roundId))!;
  for (const i of invites) {
    const { priceMinor, terms } = windowPrice({ predictedMinor, people, brand: i.brand, floorMinor, w });
    const bidId = await ctx.db.insert("roundBids", {
      roundId,
      advertiserId: i.advertiserId,
      campaignId: i.campaign._id,
      agentKeyId: i.key._id,
      match: i.match,
      brand: i.brand,
      priceTerms: terms,
      offerMinor: priceMinor,
      amountMinor: null,
      status: "invited",
    });
    await step(ctx, round, i.advertiserId, "host", "offer", priceMinor);
    await ctx.scheduler.runAfter(0, internal.roundDelivery.deliver, { bidId, event: "round_offer" });
  }
  await recordAudit(ctx, {
    workspaceId: billboard.workspaceId,
    traceId: `round:${roundId}`,
    actor: `seller-agent:${billboard.name}`,
    type: "round.started",
    subjectId: roundId,
    reason: `Window ${new Date(closesAt).toISOString().slice(11, 19)} on ${billboard.name} (${trigger}): predicted ${usd(predictedMinor)}, ${people ?? "no"} people, ${invites.length} offered${notMatching.length ? `; not offered: ${notMatching.join(", ")}` : ""}`,
  });
  await ctx.scheduler.runAt(closesAt, internal.rounds.closeRound, { roundId });
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

/** One company's last answer, for the outcome sentence. */
function answerOf(b: Doc<"roundBids">): string {
  if (b.status === "passed") return b.reasoning ?? "passed";
  if (b.status === "bid") return `agreed ${usd(b.amountMinor ?? 0)}`;
  if (b.amountMinor !== null) return `offered ${usd(b.amountMinor)}, host asked ${usd(b.offerMinor ?? 0)}`;
  return "no answer";
}

/**
 * Close the round at its deadline (idempotent: only a round still bidding
 * changes): the highest agreed price wins and is told to pay; everyone else
 * lost. Nobody agreed -> unsold, the house ad plays. The window is saved for
 * the price model either way.
 */
export async function closeRoundCore(ctx: MutationCtx, roundId: Id<"rounds">): Promise<void> {
  const round = await ctx.db.get(roundId);
  if (!round || round.status !== "bidding") return;
  const bids = await bidsOf(ctx, roundId);
  const agreed = bids
    .filter((b) => b.status === "bid" && b.amountMinor !== null)
    .map((b) => ({ id: b._id as string, amountMinor: b.amountMinor!, agreedAt: b.agreedAt ?? round.closesAt }));
  const billboard = await ctx.db.get(round.billboardId);
  const now = Date.now();
  await ctx.db.patch(roundId, { closedAt: now });
  const names = new Map<string, string>();
  for (const b of bids) names.set(b._id, await companyName(ctx, b.advertiserId));
  let winnerMinor: number | null = null;
  let winnerBidId: Id<"roundBids"> | undefined;
  const remaining = [...agreed];
  for (;;) {
    const best = bestAgreed(remaining);
    if (!best) break;
    const others = agreed.filter((a) => a.id !== best.id).sort((x, y) => y.amountMinor - x.amountMinor);
    const outcome = `${names.get(best.id)} wins at ${usd(best.amountMinor)}${others.length ? `; ${others.map((o) => `${names.get(o.id)} ${usd(o.amountMinor)}`).join(", ")}` : ""}.`;
    const result = await awardCore(ctx, (await ctx.db.get(roundId))!, best.id as Id<"roundBids">, best.amountMinor, outcome);
    if (result === "awarded") {
      winnerMinor = best.amountMinor;
      winnerBidId = best.id as Id<"roundBids">;
      break;
    }
    if (result === "ended") {
      await recordInviteOutcomes(ctx, round.billboardId, round.workspaceId, await bidsOf(ctx, roundId), undefined, Date.now());
      return;
    }
    remaining.splice(remaining.indexOf(best), 1);
  }
  if (winnerMinor === null) {
    for (const b of bids) if (b.status === "invited" || b.status === "bid") await ctx.db.patch(b._id, { status: "lost" });
    const reasons = bids.map((b) => `${names.get(b._id)}: ${answerOf(b)}`);
    const why = bids.length === 0 ? (round.outcome ?? NO_INVITES) : `No agreed price. ${reasons.join("; ")}.`;
    await endUnsold(ctx, round, `House ad plays this window. ${why}`);
  }
  if (billboard) {
    await recordWindow(ctx, { billboardId: billboard._id, at: round.spotStartAt, utcOffsetMinutes: billboard.utcOffsetMinutes, people: round.crowd, winnerMinor });
  }
  const finalBids = await bidsOf(ctx, roundId);
  await recordInviteOutcomes(ctx, round.billboardId, round.workspaceId, finalBids, winnerBidId, Date.now());
}

/**
 * The win: a quote and a hold at the agreed price, the winner told to pay
 * (round_won), everyone else told they lost. "skip" when this key can't buy
 * any more (the next best agreed price is tried); "ended" when the hold
 * can't be taken (the round ends unsold).
 */
export async function awardCore(ctx: MutationCtx, round: Doc<"rounds">, bidId: Id<"roundBids">, priceMinor: number, outcome: string): Promise<"awarded" | "skip" | "ended"> {
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
    slotIds: [],
    amountMinor: priceMinor,
    currency: "USD",
    expiresAt: now + HOLD_TTL_MS,
    pricingBasis: [
      `30-second window on ${billboard?.name ?? "screen"} from ${new Date(round.spotStartAt).toISOString()}: highest agreed price ${usd(priceMinor)}`,
      ...(bid.priceTerms ? [`a x predicted ${usd(bid.priceTerms.modelMinor)} + b x people ${usd(bid.priceTerms.peopleMinor)} + c x brand ${usd(bid.priceTerms.brandMinor)}`] : []),
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
      ttlMs: HOLD_TTL_MS,
    });
    holdId = hold._id;
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    await ctx.db.patch(quoteId, { status: "expired" });
    const data = error.data as { code?: string; message?: string };
    await endUnsold(ctx, round, data.code === "SLOT_UNAVAILABLE" ? SOLD_ELSEWHERE : `Couldn't hold the window: ${data.message ?? data.code ?? "unknown error"}.`);
    return "ended";
  }
  await ctx.db.patch(round._id, { status: "awarded", winnerBidId: bidId, priceMinor, holdId, outcome });
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
    reason: `${outcome} Hold ${holdId}; pay within ${PAY_DEADLINE_MS / 1000} s.`,
  });
  await ctx.scheduler.runAfter(PAY_DEADLINE_MS, internal.rounds.payDeadline, { roundId: round._id, holdId });
  return "awarded";
}

/** The winner didn't pay: release its hold, mark it defaulted; the house ad plays the window. */
async function defaultWinner(ctx: MutationCtx, round: Doc<"rounds">, holdId: Id<"holds">, reason: string): Promise<void> {
  const hold = await ctx.db.get(holdId);
  if (hold?.status === "active") await endHold(ctx, hold, "released", "system", `Round winner didn't pay: ${reason}`);
  const winner = round.winnerBidId ? await ctx.db.get(round.winnerBidId) : null;
  if (winner) await ctx.db.patch(winner._id, { status: "defaulted" });
  const who = winner ? await companyName(ctx, winner.advertiserId) : "The winner";
  await ctx.db.patch(round._id, { holdId: undefined, winnerBidId: undefined });
  await endUnsold(ctx, round, `Payment failed: ${who}'s payment failed: ${reason}. House ad plays this window.`);
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

/** After the pay deadline: paid -> nothing; a payment settling -> look again once; otherwise the winner defaults. */
export const payDeadline = internalMutation({
  args: { roundId: v.id("rounds"), holdId: v.id("holds"), recheck: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const round = await ctx.db.get(args.roundId);
    if (!round || round.status !== "awarded" || round.holdId !== args.holdId) return null;
    const hold = await ctx.db.get(args.holdId);
    if (!hold || hold.status === "converted") return null;
    const now = Date.now();
    if (!args.recheck && hold.status === "active" && hold.expiresAt > now && (await lockHeld(ctx, holdLockKey(hold._id), now))) {
      await ctx.scheduler.runAfter(PAY_RECHECK_MS, internal.rounds.payDeadline, { ...args, recheck: true });
      return null;
    }
    await defaultWinner(ctx, round, args.holdId, `not paid within ${(PAY_DEADLINE_MS + (args.recheck ? PAY_RECHECK_MS : 0)) / 1000} s`);
    return null;
  },
});

/** Should this screen keep looping? Online, paired, and its host has auto-sell on. */
async function keepsSelling(ctx: QueryCtx, billboardId: Id<"billboards">): Promise<boolean> {
  const b = await ctx.db.get(billboardId);
  if (!b?.workspaceId || b.retiredAt !== undefined || b.deviceStatus !== "online" || !b.deviceId) return false;
  return (await ctx.db.get(b.workspaceId))?.autoSellRounds !== false;
}

/** The deadline: close this round, then start the next window's round right away. */
export const closeRound = internalMutation({
  args: { roundId: v.id("rounds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const round = await ctx.db.get(args.roundId);
    if (!round) return null;
    await closeRoundCore(ctx, args.roundId);
    if (await keepsSelling(ctx, round.billboardId)) await startRoundCore(ctx, round.billboardId, "timer");
    return null;
  },
});

/**
 * An invited company's answer (POST /api/agent/rounds/{id}/bid), dealt with
 * on its own. Two turns: `amountMinor` at or above the host's price agrees
 * at that price; below it (at or above the floor) the host counters once,
 * halfway, and the company's second answer is final (agreed at that amount);
 * null passes. Agreed prices wait for the close, where the highest wins.
 */
export const submitBid = internalMutation({
  args: { token: v.string(), roundId: v.string(), amountMinor: v.union(v.number(), v.null()), reasoning: v.optional(v.string()) },
  returns: v.object({
    status: v.union(v.literal("agreed"), v.literal("countered"), v.literal("passed")),
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
    if (round.status !== "bidding" || now > round.closesAt) fail("ROUND_CLOSED", "This window is no longer for sale");
    if (row.status !== "invited") fail("ALREADY_ANSWERED", "You already gave your final answer for this window");
    const reasoning = args.reasoning?.slice(0, 300);
    if (args.amountMinor === null) {
      await ctx.db.patch(row._id, { status: "passed", reasoning, answeredAt: now });
      await step(ctx, round, row.advertiserId, "company", "pass", null, reasoning);
      return { status: "passed" as const, priceMinor: null };
    }
    const amount = args.amountMinor;
    if (!Number.isSafeInteger(amount) || amount <= 0) fail("INVALID_INPUT", "amountMinor must be whole cents above 0, or null to pass");
    if (amount < round.floorMinor) fail("BELOW_FLOOR", `Offers start at the ${usd(round.floorMinor)} floor`);
    const price = row.offerMinor ?? round.askingMinor;
    const agreedAmount = Math.min(amount, price);
    const over = replyAllowed(agent.key.standing, agreedAmount, await spentTodayForAdvertiserMinor(ctx, agent.key.advertiserId, now));
    if (over) fail("OVER_LIMIT", `Offer is ${over}`);
    try {
      await assertWithinBudget(ctx, agent.key, agreedAmount);
    } catch {
      fail("OVER_LIMIT", "Offer is over this key's budget cap");
    }
    const reply = hostReply({ amountMinor: amount, priceMinor: price, countered: row.countered === true });
    if (reply.kind === "counter") {
      await ctx.db.patch(row._id, { amountMinor: amount, offerMinor: reply.priceMinor, countered: true, reasoning, answeredAt: now });
      await step(ctx, round, row.advertiserId, "company", "counter", amount, reasoning);
      await step(ctx, round, row.advertiserId, "host", "counter", reply.priceMinor);
      await ctx.scheduler.runAfter(0, internal.roundDelivery.deliver, { bidId: row._id, event: "round_counter" });
      return { status: "countered" as const, priceMinor: reply.priceMinor };
    }
    await ctx.db.patch(row._id, { amountMinor: reply.priceMinor, status: "bid", agreedAt: now, reasoning, answeredAt: now });
    await step(ctx, round, row.advertiserId, "company", amount >= price ? "accept" : "counter", amount >= price ? price : amount, reasoning);
    if (amount < price) await step(ctx, round, row.advertiserId, "host", "accept", reply.priceMinor);
    return { status: "agreed" as const, priceMinor: reply.priceMinor };
  },
});

// ---------------------------------------------------------------- triggers

/** Camera arrivals and a live event start the loop through here (a no-op while a round is running). */
export const trigger = internalMutation({
  args: { billboardId: v.id("billboards"), trigger: roundTrigger },
  returns: v.null(),
  handler: async (ctx, args) => {
    await startRoundCore(ctx, args.billboardId, args.trigger);
    return null;
  },
});

/** The host's "Sell now": start the loop on this screen right away. */
export const sellNow = mutation({
  args: { billboardId: v.id("billboards") },
  returns: v.object({ roundId: v.union(v.id("rounds"), v.null()), reason: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
    const last = await clearStale(ctx, args.billboardId, Date.now());
    if (last?.status === "bidding") return { roundId: null, reason: "A sale is already running on this screen." };
    const roundId = await startRoundCore(ctx, args.billboardId, "sell_now");
    return { roundId, reason: roundId ? null : "This screen can't sell (retired or not in a workspace)." };
  },
});

/** Turn the selling loop on or off for the workspace (on by default; each company's daily budget caps what it spends). */
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

/** Every minute, the watchdog: an online, paired screen with no round running gets its loop started. */
export const autoSellTick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const workspaces = await ctx.db.query("workspaces").take(MAX_AUTO_WORKSPACES * 4);
    for (const ws of workspaces.filter((w) => w.autoSellRounds !== false).slice(0, MAX_AUTO_WORKSPACES)) {
      const screens = await ctx.db
        .query("billboards")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id))
        .take(MAX_AUTO_SCREENS);
      for (const screen of screens) {
        if (screen.deviceStatus !== "online" || !screen.deviceId) continue;
        if ((await latestRound(ctx, screen._id))?.status === "bidding") continue;
        await startRoundCore(ctx, screen._id, "timer");
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------- what people see

const priceTerms = v.object({
  modelMinor: v.number(),
  peopleMinor: v.number(),
  brandMinor: v.number(),
  capMinor: v.number(),
  capped: v.union(v.literal("floor"), v.literal("cap"), v.null()),
});

const bidView = v.object({
  advertiserId: v.id("advertisers"),
  company: v.string(),
  /** The host's price to this company now (its first offer, or the host's counter). */
  offerMinor: v.union(v.number(), v.null()),
  /** The company's latest answer (agreed price once status is "bid"). */
  amountMinor: v.union(v.number(), v.null()),
  countered: v.boolean(),
  agreedAt: v.union(v.number(), v.null()),
  reasoning: v.union(v.string(), v.null()),
  match: v.union(v.number(), v.null()),
  brand: v.union(v.number(), v.null()),
  priceTerms: v.union(priceTerms, v.null()),
  status: roundBidStatus,
});

const roundView = v.object({
  roundId: v.id("rounds"),
  status: roundStatus,
  trigger: roundTrigger,
  floorMinor: v.number(),
  askingMinor: v.number(),
  signals: v.array(priceSignal),
  pricing: v.union(
    v.null(),
    v.object({ predictedMinor: v.number(), modelId: v.union(v.id("priceModels"), v.null()), people: v.union(v.number(), v.null()), a: v.number(), b: v.number(), c: v.number(), capMultiplier: v.number() }),
  ),
  crowd: v.union(v.number(), v.null()),
  closesAt: v.number(),
  spotStartAt: v.number(),
  spotEndAt: v.number(),
  createdAt: v.number(),
  priceMinor: v.union(v.number(), v.null()),
  winner: v.union(v.string(), v.null()),
  outcome: v.union(v.string(), v.null()),
  txUrl: v.union(v.string(), v.null()),
  bids: v.array(bidView),
});

async function toView(ctx: QueryCtx, round: Doc<"rounds">) {
  const bids = [];
  let winner: string | null = null;
  for (const b of await bidsOf(ctx, round._id)) {
    const company = await companyName(ctx, b.advertiserId);
    if (b._id === round.winnerBidId) winner = company;
    bids.push({
      advertiserId: b.advertiserId,
      company,
      offerMinor: b.offerMinor ?? null,
      amountMinor: b.amountMinor,
      countered: b.countered === true,
      agreedAt: b.agreedAt ?? null,
      reasoning: b.reasoning ?? null,
      match: b.match,
      brand: b.brand ?? null,
      priceTerms: b.priceTerms ?? null,
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
    pricing: round.pricing ?? null,
    crowd: round.crowd,
    closesAt: round.closesAt,
    spotStartAt: round.spotStartAt,
    spotEndAt: round.spotEndAt,
    createdAt: round.createdAt,
    priceMinor: round.priceMinor ?? null,
    winner,
    outcome: round.outcome ?? null,
    txUrl: round.paymentTx && round.paymentNetwork ? (explorerTxUrl(round.paymentNetwork, round.paymentTx) ?? null) : null,
    bids,
  };
}

/** Presenter page: every screen of the workspace with its running round and the one before it, and the auto-sell switch. */
export const live = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({
    autoSell: v.boolean(),
    screens: v.array(
      v.object({ billboardId: v.id("billboards"), name: v.string(), online: v.boolean(), round: v.union(roundView, v.null()), previous: v.union(roundView, v.null()) }),
    ),
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
      const [round, previous] = await ctx.db
        .query("rounds")
        .withIndex("by_billboard_and_createdAt", (q) => q.eq("billboardId", s._id))
        .order("desc")
        .take(2);
      out.push({
        billboardId: s._id,
        name: s.name,
        online: s.deviceStatus === "online",
        round: round ? await toView(ctx, round) : null,
        previous: previous ? await toView(ctx, previous) : null,
      });
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
      /** The host's price to this company (after any counter). */
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
