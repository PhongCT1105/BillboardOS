import { ConvexError, v, type Infer } from "convex/values";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { roundTrigger } from "./schemaParts/rounds";
import { recordAudit } from "./lib/audit";
import { assertWithinBudget, authenticateAgent, keyStatus } from "./lib/agentKeys";
import { matchScore } from "./lib/match";
import { MIN_REMAINING_MS, audienceMix, replyAllowed } from "./lib/moment";
import { creativeReady } from "./lib/momentHooks";
import { CAMERA_COOLDOWN_MS, MAX_INVITES, ROUND_CLOSE_MS, askingPrice, closeOutcome, priceSignals } from "./lib/rounds";
import { activeEvent, spentTodayForAdvertiserMinor } from "./moments";

/**
 * Simple bidding rounds (spec 2026-10-24-simple-bidding-rounds-design):
 * start -> price -> invite -> bid -> close, then pay -> play. One round sells
 * the spot on air now on one screen. Every invited company answers once
 * (sealed); the round closes when all have answered or after 5 s. Signals
 * only move the asking price; nothing but "no bid at or above the floor"
 * stops a sale, and every round ends with an outcome sentence.
 */

const BUCKET_MS = 15 * 60_000;
const MAX_APPROVALS_SCANNED = 100;
const MAX_KEYS_SCANNED = 20;
const NO_INVITES = "No company agents with an approved ad and budget.";

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

/**
 * The spot on air now: the rest of the current slot (>= 3 min left), else the
 * next slot if it starts within one slot length (a new screen's inventory
 * starts at the next quarter hour). Available only. The autopilot hands over
 * slots under 15 min out, so rounds and forward offers never overlap.
 */
async function onAirSpot(ctx: QueryCtx, billboardId: Id<"billboards">, now: number): Promise<Doc<"slots"> | null> {
  const slots = await ctx.db
    .query("slots")
    .withIndex("by_billboard_and_startAt", (q) => q.eq("billboardId", billboardId).gte("startAt", now - BUCKET_MS).lte("startAt", now + BUCKET_MS))
    .take(4);
  const free = async (s: Doc<"slots">) => s.state === "available" && !(s.auctionId && (await ctx.db.get(s.auctionId))?.status === "open");
  for (const s of slots) {
    if (s.startAt <= now && s.endAt - now >= MIN_REMAINING_MS && (await free(s))) return s;
  }
  for (const s of slots) {
    if (s.startAt > now && (await free(s))) return s;
  }
  return null;
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

type Invite = { advertiserId: Id<"advertisers">; campaign: Doc<"campaigns">; key: Doc<"agentKeys"> };

/** A key that can take part: active, webhook, bid + pay scopes, allowed for the campaign. */
function canBid(k: Doc<"agentKeys">, campaignId: Id<"campaigns">, now: number): boolean {
  if (keyStatus(k, now) !== "active" || !k.webhookUrl) return false;
  if (!k.scopes.includes("bid") || !k.scopes.includes("pay")) return false;
  return !k.campaignIds || k.campaignIds.includes(campaignId);
}

/**
 * Everyone invited (spec §3): a company with an ad ready on this host, an
 * agent key that can bid and pay, and budget left. One key and one campaign
 * per company: the built-in agent's first, else the newest that qualify.
 */
async function invitees(ctx: QueryCtx, workspaceId: Id<"workspaces">, now: number): Promise<Invite[]> {
  const approvals = await ctx.db
    .query("creativeApprovals")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_APPROVALS_SCANNED);
  const ready = new Map<Id<"advertisers">, Doc<"campaigns">[]>();
  for (const a of approvals) {
    const c = await ctx.db.get(a.campaignId);
    if (!c || c.status !== "active" || !(await creativeReady(ctx, c, workspaceId))) continue;
    ready.set(c.advertiserId, [...(ready.get(c.advertiserId) ?? []), c]);
  }
  const out: Invite[] = [];
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
    out.push(pick);
  }
  return out;
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
  const last = await latestRound(ctx, billboardId);
  if (last && (last.status === "bidding" || last.status === "awarded")) return null;
  if (trigger === "camera" && last && now - (last.closedAt ?? last.createdAt) < CAMERA_COOLDOWN_MS) return null;
  const spot = await onAirSpot(ctx, billboardId, now);
  if (!spot) return null;

  const crowd = await crowdNow(ctx, billboardId, now);
  const event = await activeEvent(ctx, billboardId, now);
  const signals = priceSignals({ peakInView: crowd, usualInView: billboard.usualInView, eventName: event?.name ?? null });
  const floorMinor = billboard.reserveFloorMinor;
  const mix = audienceMix(billboard.audienceTags, event?.audienceTags);
  const invites = await invitees(ctx, billboard.workspaceId, now);

  const roundId = await ctx.db.insert("rounds", {
    workspaceId: billboard.workspaceId,
    billboardId,
    slotId: spot._id,
    spotStartAt: Math.max(now, spot.startAt),
    spotEndAt: spot.endAt,
    trigger,
    status: "bidding",
    floorMinor,
    askingMinor: askingPrice(floorMinor, signals),
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
      match: matchScore(mix, i.campaign.targetAudience),
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
    reason: `Round on ${billboard.name} (${trigger}): floor ${usd(floorMinor)}, asking ${usd(askingPrice(floorMinor, signals))}; ${invites.length} invited`,
  });
  if (invites.length === 0) {
    await endUnsold(ctx, (await ctx.db.get(roundId))!, NO_INVITES);
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

/**
 * Close a round (idempotent: only a round still bidding changes). No bid at
 * or above the floor: unsold with every reason. Otherwise the winner is
 * awarded at the second price (closeOutcome).
 */
export async function closeRoundCore(ctx: MutationCtx, roundId: Id<"rounds">): Promise<void> {
  const round = await ctx.db.get(roundId);
  if (!round || round.status !== "bidding") return;
  const bids = await bidsOf(ctx, roundId);
  const names = new Map<string, string>();
  for (const b of bids) names.set(b._id, await companyName(ctx, b.advertiserId));
  const valid = bids.filter((b) => b.status === "bid" && b.amountMinor !== null);
  const result = closeOutcome(
    valid.map((b) => ({ id: b._id, amountMinor: b.amountMinor!, answeredAt: b.answeredAt ?? round.closesAt })),
    round.askingMinor,
    round.floorMinor,
  );
  if (result.kind === "unsold") {
    const reasons = bids.map((b) => `${names.get(b._id)}: ${b.status === "passed" ? (b.reasoning ?? "passed") : "no answer"}`);
    await endUnsold(ctx, round, `Unsold: no bid at or above the ${usd(round.floorMinor)} floor. ${reasons.join("; ")}.`);
    return;
  }
  const others = valid
    .filter((b) => b._id !== result.winnerId)
    .sort((a, b) => b.amountMinor! - a.amountMinor!)
    .map((b) => `${names.get(b._id)} bid ${usd(b.amountMinor!)}`);
  const winner = valid.find((b) => b._id === result.winnerId)!;
  const outcome = `${names.get(winner._id)} wins at ${usd(result.priceMinor)} (bid ${usd(winner.amountMinor!)})${others.length ? `; ${others.join(", ")}` : ""}.`;
  await ctx.db.patch(roundId, { closedAt: Date.now() });
  await awardCore(ctx, round, winner._id, result.priceMinor, result.runnerUpId as Id<"roundBids"> | null, outcome);
}

/** Award the spot to one bid at a price. (Payment wiring follows in the pay task.) */
export async function awardCore(
  ctx: MutationCtx,
  round: Doc<"rounds">,
  bidId: Id<"roundBids">,
  priceMinor: number,
  runnerUpBidId: Id<"roundBids"> | null,
  outcome: string,
): Promise<boolean> {
  await ctx.db.patch(round._id, {
    status: "awarded",
    winnerBidId: bidId,
    runnerUpBidId: runnerUpBidId ?? undefined,
    priceMinor,
    outcome,
  });
  for (const b of await bidsOf(ctx, round._id)) {
    if (b._id === bidId) await ctx.db.patch(b._id, { status: "won" });
    else if (b.status === "bid") await ctx.db.patch(b._id, { status: "lost" });
  }
  return true;
}

export const closeRound = internalMutation({
  args: { roundId: v.id("rounds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await closeRoundCore(ctx, args.roundId);
    return null;
  },
});

/**
 * An invited agent's one sealed answer (POST /api/agent/rounds/{id}/bid):
 * an amount at or above the floor within its own limits, or null to pass.
 * Answering again replaces the earlier answer until the round closes; the
 * last answer closes the round at once.
 */
export const submitBid = internalMutation({
  args: { token: v.string(), roundId: v.string(), amountMinor: v.union(v.number(), v.null()), reasoning: v.optional(v.string()) },
  returns: v.object({ status: v.union(v.literal("bid"), v.literal("passed")) }),
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
    if (round.status !== "bidding" || now > round.closesAt) fail("ROUND_CLOSED", "This round is closed");
    const reasoning = args.reasoning?.slice(0, 300);
    if (args.amountMinor === null) {
      await ctx.db.patch(row._id, { amountMinor: null, status: "passed", reasoning, answeredAt: now });
    } else {
      const amount = args.amountMinor;
      if (!Number.isSafeInteger(amount) || amount <= 0) fail("INVALID_INPUT", "amountMinor must be whole cents above 0, or null to pass");
      if (amount < round.floorMinor) fail("BELOW_FLOOR", `Bids start at the ${usd(round.floorMinor)} floor`);
      const over = replyAllowed(agent.key.standing, amount, await spentTodayForAdvertiserMinor(ctx, agent.key.advertiserId, now));
      if (over) fail("OVER_LIMIT", `Bid is ${over}`);
      try {
        await assertWithinBudget(ctx, agent.key, amount);
      } catch {
        fail("OVER_LIMIT", "Bid is over this key's budget cap");
      }
      await ctx.db.patch(row._id, { amountMinor: amount, status: "bid", reasoning, answeredAt: now });
    }
    const bids = await bidsOf(ctx, round._id);
    if (bids.every((b) => b.status !== "invited")) await closeRoundCore(ctx, round._id);
    return { status: args.amountMinor === null ? ("passed" as const) : ("bid" as const) };
  },
});
