import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { assertWithinBudget, authenticateAgent, keyStatus } from "./lib/agentKeys";
import { PRICING_POLICY_VERSION } from "./lib/pricing";
import {
  BIDDING_MS,
  EXTENSION_MS,
  MAX_BIDS_PER_COMPANY,
  MAX_EXTENSIONS,
  NEGOTIATION_MAX_ROUNDS,
  NEGOTIATION_TIME_CAP_MS,
  checkBid,
  extendLive,
  joinOutcome,
  minNextLiveBid,
  type JoinReply,
} from "./lib/liveAuction";
import { sellerRespond, type SellerDecision } from "./lib/negotiation";
import { MAX_OFFERS, PAY_WINDOW_MS, rankReplies, replyAllowed, type Standing } from "./lib/moment";
import { addMomentStep, releaseWorkspace } from "./lib/momentHooks";
import { endHold, takeHold } from "./holds";
import { scheduleReoffer, spentTodayMinor } from "./moments";

/**
 * The live auction after a spot is announced (ADR 0006): the join window,
 * then an auction (2+ companies joined), a sale at the opening price (1), a
 * negotiation (only counters) or no takers; then the award, the 60 s pay
 * deadline (runner-up on default) and the release of the host's queue.
 * Every path ends the moment, so the host is never left busy.
 */

/** The host is free again: the next queued screen (first come, first served) sells now. */
export { releaseWorkspace };

const FLASH_HOLD_TTL_MS = 3 * 60_000;
const MAX_BIDS_SCANNED = 100;

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

function fail(code: string, message: string, extra: Record<string, string | number> = {}): never {
  throw new ConvexError({ code, message, ...extra });
}

async function offersOf(ctx: MutationCtx, momentId: Id<"moments">): Promise<Doc<"flashOffers">[]> {
  return await ctx.db
    .query("flashOffers")
    .withIndex("by_moment", (q) => q.eq("momentId", momentId))
    .take(MAX_OFFERS + 1);
}

/** Companies in the auction: everyone who joined (accepted or countered). */
const inAuction = (o: Doc<"flashOffers">) => o.status === "accepted" || o.status === "countered";

async function deliverTo(ctx: MutationCtx, offers: Doc<"flashOffers">[], event: "auction_started" | "auction_update") {
  for (const o of offers) await ctx.scheduler.runAfter(0, internal.momentDelivery.deliver, { offerId: o._id, event });
}

/** Nobody bought: no takers, re-offer lower after a pause (above the minimum), and free the host. */
async function endNoTakers(ctx: MutationCtx, momentId: Id<"moments">, label: string, detail: string): Promise<void> {
  const moment = (await ctx.db.get(momentId))!;
  await ctx.db.patch(momentId, { status: "no_takers" });
  const reoffer = await scheduleReoffer(ctx, moment);
  await addMomentStep(
    ctx,
    moment,
    "no_takers",
    label,
    `${detail} ${reoffer ? "Re-offering in 20 s, about 15% lower." : `Holding at the ${usd(moment.floorMinor)} minimum.`}`,
  );
  await recordAudit(ctx, {
    workspaceId: moment.workspaceId,
    traceId: `moment:${momentId}`,
    actor: "system",
    type: "moment.closed",
    subjectId: momentId,
    reason: `${label} (minimum ${usd(moment.floorMinor)})`.slice(0, 1000),
  });
  await releaseWorkspace(ctx, moment.workspaceId);
}

// ---------------------------------------------------------------- award, default

/**
 * Hold the spot for the best acceptable reply (`firstOfferId` first when
 * given, then by amount at or above the minimum, earliest on ties) and give
 * the winner 60 s to pay. Returns false when nobody can take it; marks the
 * moment failed (and frees the host) when the spot can't be held.
 */
export async function award(
  ctx: MutationCtx,
  moment: Doc<"moments">,
  excludeOfferIds: Set<string>,
  firstOfferId?: Id<"flashOffers">,
): Promise<boolean> {
  const offers = await offersOf(ctx, moment._id);
  const ranked = rankReplies(
    offers
      .filter((o) => !excludeOfferIds.has(o._id))
      .map((o) => ({ offerId: o._id, status: o.status, amountMinor: o.replyAmountMinor ?? null, repliedAt: o.repliedAt ?? null })),
    moment.floorMinor,
  );
  if (firstOfferId) ranked.sort((a, b) => Number(b.offerId === firstOfferId) - Number(a.offerId === firstOfferId));
  const workspace = (await ctx.db.get(moment.workspaceId))!;
  for (const r of ranked) {
    const offer = offers.find((o) => o._id === r.offerId)!;
    const key = await ctx.db.get(offer.agentKeyId);
    const amount = r.amountMinor!;
    if (!key || keyStatus(key, Date.now()) !== "active") continue;
    try {
      await assertWithinBudget(ctx, key, amount);
    } catch {
      await addMomentStep(ctx, moment, `skip:${offer._id}`, "Skipped a reply over its budget cap");
      continue;
    }
    const now = Date.now();
    const company = (await ctx.db.get(offer.advertiserId))?.displayName ?? "company";
    const actor = `agent:${company}/${key.name}`;
    const traceId = `moment:${moment._id}`;
    const quoteId = await ctx.db.insert("quotes", {
      workspaceId: moment.workspaceId,
      campaignId: offer.campaignId,
      billboardId: moment.billboardId,
      slotIds: [moment.slotId],
      amountMinor: amount,
      currency: "USD",
      expiresAt: now + 10 * 60_000,
      pricingBasis: [
        `Live spot from ${workspace.name}: ${Math.round((moment.spotEndAt - moment.spotStartAt) / 60_000)} min, opening ${usd(moment.priceMinor)}, won at ${usd(amount)}`,
        moment.reasoning,
      ],
      confidence: "medium",
      policyVersion: PRICING_POLICY_VERSION,
      status: "open",
      traceId,
      agentKeyId: key._id,
      screenAmountMinor: moment.priceMinor,
    });
    let hold: Doc<"holds">;
    try {
      hold = await takeHold(ctx, (await ctx.db.get(quoteId))!, `moment:${moment._id}:${offer._id}`, actor, {
        agentKeyId: key._id,
        inProgressMinRemainingMs: 60_000,
        ttlMs: FLASH_HOLD_TTL_MS,
      });
    } catch (error) {
      await ctx.db.patch(quoteId, { status: "expired" });
      const message = error instanceof ConvexError ? String((error.data as { message?: string }).message) : "hold failed";
      await addMomentStep(ctx, moment, "failed", "Could not hold the spot", message);
      await ctx.db.patch(moment._id, { status: "failed" });
      // Nobody gets this spot: every company still in the running hears it lost.
      for (const o of offers) {
        if (o.status === "accepted" || o.status === "countered") {
          await ctx.db.patch(o._id, { status: "lost" });
          await ctx.scheduler.runAfter(0, internal.momentDelivery.deliver, { offerId: o._id, event: "flash_lost" });
        }
      }
      await releaseWorkspace(ctx, moment.workspaceId);
      return true; // nothing else can win this slot either
    }
    await ctx.db.patch(offer._id, { status: "won", holdId: hold._id });
    await ctx.db.patch(moment._id, { status: "awarded", winnerOfferId: offer._id, holdId: hold._id });
    await addMomentStep(ctx, moment, "winner", `${company} wins at ${usd(amount)}`, `Best offer at or above the ${usd(moment.floorMinor)} minimum.`, now);
    await addMomentStep(ctx, moment, "hold", "Spot held for the winner", `Hold ${hold._id}; pay over x402 within ${PAY_WINDOW_MS / 1000} s.`, now);
    await recordAudit(ctx, {
      workspaceId: moment.workspaceId,
      traceId,
      actor: `seller-agent:${workspace.name}`,
      type: "moment.awarded",
      subjectId: moment._id,
      reason: `Live spot awarded to ${company} at ${usd(amount)} (opening ${usd(moment.priceMinor)}, minimum ${usd(moment.floorMinor)}); hold ${hold._id}`,
    });
    await ctx.scheduler.runAfter(0, internal.momentDelivery.deliver, { offerId: offer._id, event: "flash_won" });
    for (const o of offers) {
      if (o._id === offer._id) continue;
      if (o.status === "accepted" || o.status === "countered") {
        await ctx.db.patch(o._id, { status: "lost" });
        await ctx.scheduler.runAfter(0, internal.momentDelivery.deliver, { offerId: o._id, event: "flash_lost" });
      }
    }
    await ctx.scheduler.runAfter(PAY_WINDOW_MS, internal.liveAuction.payDeadline, { momentId: moment._id, offerId: offer._id });
    return true;
  }
  return false;
}

/**
 * The winner did not pay: release its hold, mark it defaulted, open a
 * winner_default exception and award the next best reply (`award(…, exclude)`);
 * with nobody left the moment fails and the host is free.
 */
async function defaultWinner(
  ctx: MutationCtx,
  moment: Doc<"moments">,
  offer: Doc<"flashOffers">,
  hold: Doc<"holds">,
  why: { release: string; evidence: string; step: string },
): Promise<void> {
  if (hold.status === "active") await endHold(ctx, hold, "released", "system", why.release);
  await ctx.db.patch(offer._id, { status: "defaulted" });
  await ctx.db.insert("financeExceptions", {
    workspaceId: moment.workspaceId,
    kind: "winner_default",
    status: "open",
    holdId: hold._id,
    billboardId: moment.billboardId,
    advertiserId: offer.advertiserId,
    expectedMinor: hold.amountMinor,
    observedMinor: 0,
    evidence: why.evidence,
    nextAction: "Review the buyer agent's standing instructions or wallet; the spot went to the next best offer if any.",
  });
  await addMomentStep(ctx, moment, "defaulted", why.step, "Hold released; winner_default exception opened; offering the next best bid.");
  await ctx.db.patch(moment._id, { winnerOfferId: undefined, holdId: undefined });
  const offers = await offersOf(ctx, moment._id);
  const excluded = new Set<string>([offer._id]);
  for (const o of offers) if (o.status === "defaulted") excluded.add(o._id);
  // Restore "lost" replies so they can be ranked again at their last bid.
  for (const o of offers) if (o.status === "lost") await ctx.db.patch(o._id, { status: o.replyAmountMinor === o.priceMinor ? "accepted" : "countered" });
  const awarded = await award(ctx, (await ctx.db.get(moment._id))!, excluded);
  if (!awarded) {
    await ctx.db.patch(moment._id, { status: "failed" });
    await addMomentStep(ctx, moment, "failed", "No one left to award", "The spot went back on sale.");
    await releaseWorkspace(ctx, moment.workspaceId);
  }
}

/** The winner has 60 s to pay; otherwise release, open a winner_default exception, award the next best. */
export const payDeadline = internalMutation({
  args: { momentId: v.id("moments"), offerId: v.id("flashOffers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const moment = await ctx.db.get(args.momentId);
    const offer = await ctx.db.get(args.offerId);
    if (!moment || !offer || moment.winnerOfferId !== offer._id || moment.status !== "awarded" || !offer.holdId) return null;
    const hold = await ctx.db.get(offer.holdId);
    if (!hold || hold.status === "converted") return null; // paid: nothing to do
    await defaultWinner(ctx, moment, offer, hold, {
      release: "Live spot winner did not pay within 60 s",
      evidence: `Live spot winner did not pay ${usd(hold.amountMinor)} within ${PAY_WINDOW_MS / 1000} s (moment ${moment._id}).`,
      step: "Winner did not pay in time",
    });
    return null;
  },
});

/**
 * The winner's agent tried to pay and could not (no wallet, empty wallet, x402
 * refused): no rehearsal, no waiting out the 60 s. The spot goes to the next
 * best offer now, through the same path as a missed deadline.
 */
export const paymentFailed = internalMutation({
  args: { holdId: v.id("holds"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const moment = await ctx.db
      .query("moments")
      .withIndex("by_hold", (q) => q.eq("holdId", args.holdId))
      .first();
    if (!moment || moment.status !== "awarded" || !moment.winnerOfferId) return null;
    const offer = await ctx.db.get(moment.winnerOfferId);
    const hold = await ctx.db.get(args.holdId);
    // Paid after all (or already moved on): nothing to do.
    if (!offer || offer.holdId !== args.holdId || !hold || hold.status !== "active") return null;
    const reason = args.reason.slice(0, 200);
    await defaultWinner(ctx, moment, offer, hold, {
      release: `Live spot winner's payment failed: ${reason}`,
      evidence: `Live spot winner could not pay ${usd(hold.amountMinor)}: ${reason} (moment ${moment._id}).`,
      step: "Winner could not pay",
    });
    return null;
  },
});

// ---------------------------------------------------------------- join window

/** End the join window: auction (2+ joined), sale (1 accepted), negotiation (only counters) or no takers. */
export async function closeJoinCore(ctx: MutationCtx, momentId: Id<"moments">, why: string): Promise<void> {
  const moment = await ctx.db.get(momentId);
  if (!moment || moment.status !== "offering") return;
  const offers = await offersOf(ctx, momentId);
  for (const o of offers) if (o.status === "sent") await ctx.db.patch(o._id, { status: "expired" });
  await addMomentStep(ctx, moment, "window_closed", `Joining closed: ${why}`);
  const outcome = joinOutcome(
    offers.map((o) => ({
      offerId: o._id,
      status: (o.status === "accepted" || o.status === "countered" || o.status === "passed" ? o.status : "expired") satisfies JoinReply["status"],
      amountMinor: o.replyAmountMinor ?? null,
      repliedAt: o.repliedAt ?? null,
    })),
  );
  const now = Date.now();

  if (outcome.kind === "auction") {
    const biddingClosesAt = now + BIDDING_MS;
    await ctx.db.patch(momentId, {
      status: "bidding",
      biddingClosesAt,
      hardClosesAt: biddingClosesAt + MAX_EXTENSIONS * EXTENSION_MS,
      extensions: 0,
    });
    await addMomentStep(
      ctx,
      moment,
      "auction_started",
      `${outcome.participantIds.length} companies joined: live auction`,
      `Bidding opens at ${usd(moment.priceMinor)}; each bid beats the last by at least 5% (5¢ minimum), up to ${MAX_BIDS_PER_COMPANY} bids each. Closes in ${BIDDING_MS / 1000} s; a late bid adds ${EXTENSION_MS / 1000} s, at most twice.`,
      now,
    );
    const ids = new Set<string>(outcome.participantIds);
    await deliverTo(ctx, offers.filter((o) => ids.has(o._id)), "auction_started");
    await ctx.scheduler.runAt(biddingClosesAt, internal.liveAuction.closeBidding, { momentId });
    return;
  }

  if (outcome.kind === "sale") {
    await addMomentStep(ctx, moment, "sale", `One company joined: sold at the ${usd(moment.priceMinor)} opening price`, undefined, now);
    const offerId = outcome.offerId as Id<"flashOffers">;
    if (!(await award(ctx, (await ctx.db.get(momentId))!, new Set(), offerId))) {
      await endNoTakers(ctx, momentId, "The only taker couldn't be awarded", "Its key is inactive or over its budget cap.");
    }
    return;
  }

  if (outcome.kind === "negotiation") {
    const offer = offers.find((o) => o._id === outcome.offerId)!;
    await ctx.db.patch(momentId, { status: "negotiating", sellerMinor: moment.priceMinor, negotiationOfferId: offer._id, negotiationRound: 1 });
    const company = (await ctx.db.get(offer.advertiserId))?.displayName ?? "company";
    await addMomentStep(ctx, moment, "negotiation_started", `Only counters: negotiating with ${company}`, `Best counter ${usd(outcome.amountMinor)} against the ${usd(moment.priceMinor)} opening price; never below the ${usd(moment.floorMinor)} minimum.`, now);
    await ctx.db.insert("momentBids", {
      momentId,
      offerId: offer._id,
      advertiserId: offer.advertiserId,
      kind: "buyer_offer",
      amountMinor: outcome.amountMinor,
      at: offer.repliedAt ?? now,
      reasoning: offer.replyReasoning,
    });
    const decision = sellerRespond(
      { floorMinor: moment.floorMinor, sellerMinor: moment.priceMinor, bestBuyerMinor: null, round: 1, maxRounds: NEGOTIATION_MAX_ROUNDS },
      outcome.amountMinor,
    );
    await ctx.scheduler.runAt(moment.startedAt + NEGOTIATION_TIME_CAP_MS, internal.liveAuction.closeNegotiation, { momentId });
    await applySellerDecision(ctx, momentId, offer, decision, 1);
    return;
  }

  await endNoTakers(ctx, momentId, "No company joined", "Every company passed or didn't answer in time.");
}

export const closeJoin = internalMutation({
  args: { momentId: v.id("moments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await closeJoinCore(ctx, args.momentId, "time is up");
    return null;
  },
});

// ---------------------------------------------------------------- negotiation

async function applySellerDecision(
  ctx: MutationCtx,
  momentId: Id<"moments">,
  offer: Doc<"flashOffers">,
  decision: SellerDecision,
  round: number,
): Promise<void> {
  const moment = (await ctx.db.get(momentId))!;
  const now = Date.now();
  if (decision.kind === "accept") {
    await ctx.db.patch(offer._id, { status: "accepted", replyAmountMinor: decision.amountMinor });
    await addMomentStep(ctx, moment, `negotiation:${round}`, `Agreed at ${usd(decision.amountMinor)}`, decision.reasoning, now);
    if (!(await award(ctx, (await ctx.db.get(momentId))!, new Set(), offer._id))) {
      await endNoTakers(ctx, momentId, "The negotiated buyer couldn't be awarded", "Its key is inactive or over its budget cap.");
    }
    return;
  }
  if (decision.kind === "reject") {
    await addMomentStep(ctx, moment, `negotiation:${round}`, "No deal", decision.reasoning, now);
    await endNoTakers(ctx, momentId, "Negotiation ended without a deal", "The final offer was below the minimum.");
    return;
  }
  await ctx.db.patch(momentId, { sellerMinor: decision.amountMinor, negotiationRound: round });
  await ctx.db.insert("momentBids", {
    momentId,
    offerId: offer._id,
    advertiserId: offer.advertiserId,
    kind: "seller_counter",
    amountMinor: decision.amountMinor,
    at: now,
    reasoning: decision.reasoning,
  });
  await addMomentStep(ctx, moment, `negotiation:${round}`, `Host counters at ${usd(decision.amountMinor)}`, decision.reasoning, now);
  await ctx.scheduler.runAfter(0, internal.momentDelivery.deliver, { offerId: offer._id, event: "negotiation_counter" });
}

/**
 * The negotiating company answered the host's counter (from the reply route):
 * accept at the host's price, counter (the host concedes on a shrinking
 * schedule, never below the minimum; the last round is accept or reject), or pass.
 */
export async function negotiationReply(
  ctx: MutationCtx,
  moment: Doc<"moments">,
  offer: Doc<"flashOffers">,
  decision: "accept" | "counter" | "pass",
  amountMinor: number | undefined,
  reasoning: string | undefined,
): Promise<void> {
  const now = Date.now();
  const company = (await ctx.db.get(offer.advertiserId))?.displayName ?? "company";
  const sellerMinor = moment.sellerMinor ?? moment.priceMinor;
  const round = (moment.negotiationRound ?? 1) + 1;
  if (decision === "pass") {
    await ctx.db.patch(offer._id, { status: "passed", replyReasoning: reasoning });
    await addMomentStep(ctx, moment, `negotiation:${round}`, `${company}: pass`, reasoning, now);
    await endNoTakers(ctx, moment._id, "Negotiation ended without a deal", `${company} walked away.`);
    return;
  }
  if (decision === "accept") {
    await addMomentStep(ctx, moment, `negotiation:${round}`, `${company}: accept ${usd(sellerMinor)}`, reasoning, now);
    await applySellerDecision(ctx, moment._id, offer, { kind: "accept", amountMinor: sellerMinor, reasoning: `${company} accepted the host's ${usd(sellerMinor)}.` }, round);
    return;
  }
  const amount = amountMinor!;
  const earlier = await ctx.db
    .query("momentBids")
    .withIndex("by_moment", (q) => q.eq("momentId", moment._id))
    .take(MAX_BIDS_SCANNED);
  const bestBuyerMinor = earlier.filter((b) => b.kind === "buyer_offer").reduce<number | null>((m, b) => Math.max(m ?? 0, b.amountMinor), null);
  await ctx.db.patch(offer._id, { status: "countered", replyAmountMinor: amount, replyReasoning: reasoning, repliedAt: now });
  await ctx.db.insert("momentBids", { momentId: moment._id, offerId: offer._id, advertiserId: offer.advertiserId, kind: "buyer_offer", amountMinor: amount, at: now, reasoning });
  await ctx.db.patch(moment._id, { negotiationRound: round });
  await addMomentStep(ctx, moment, `buyer:${round}`, `${company}: counter ${usd(amount)}`, reasoning, now);
  const response = sellerRespond({ floorMinor: moment.floorMinor, sellerMinor, bestBuyerMinor, round, maxRounds: NEGOTIATION_MAX_ROUNDS }, amount);
  await applySellerDecision(ctx, moment._id, offer, response, round);
}

/** The negotiation's time cap: still talking means no deal. */
export const closeNegotiation = internalMutation({
  args: { momentId: v.id("moments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const moment = await ctx.db.get(args.momentId);
    if (!moment || moment.status !== "negotiating") return null;
    await endNoTakers(ctx, moment._id, "Negotiation ran out of time", `No deal within ${NEGOTIATION_TIME_CAP_MS / 1000} s.`);
    return null;
  },
});

// ---------------------------------------------------------------- bidding

/** POST /api/agent/offers/{id}/bid: one bid in the live auction. */
export const placeBid = internalMutation({
  args: { token: v.string(), offerId: v.string(), amountMinor: v.number(), reasoning: v.optional(v.string()) },
  returns: v.object({
    offerId: v.id("flashOffers"),
    currentMinor: v.number(),
    youLead: v.boolean(),
    bidsLeft: v.number(),
    closesAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "bid");
    const offerId = ctx.db.normalizeId("flashOffers", args.offerId);
    const offer = offerId ? await ctx.db.get(offerId) : null;
    if (!offer || offer.agentKeyId !== agent.key._id) fail("NOT_FOUND", "Offer not found");
    const moment = (await ctx.db.get(offer.momentId))!;
    const now = Date.now();
    if (moment.status === "bidding" && !inAuction(offer)) fail("NOT_BIDDING", "You did not join this auction");
    const amount = args.amountMinor;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) fail("INVALID_INPUT", "amountMinor must be whole cents");
    const leaderMinor = moment.leaderOfferId ? (moment.currentMinor ?? null) : null;
    const minNextMinor = minNextLiveBid({ leaderMinor, openingMinor: moment.priceMinor });
    const bidCount = offer.bidCount ?? 0;
    const broken = checkBid({
      phase: moment.status,
      now,
      closesAt: moment.biddingClosesAt ?? 0,
      bidCount,
      isLeader: moment.leaderOfferId === offer._id,
      amountMinor: amount,
      minNextMinor,
    });
    if (broken) {
      const messages: Record<typeof broken, string> = {
        NOT_BIDDING: "This spot is not in a live auction",
        BIDDING_CLOSED: "Bidding has closed",
        BID_LIMIT: `At most ${MAX_BIDS_PER_COMPANY} bids per company`,
        ALREADY_LEADING: "You already lead this auction",
        BID_TOO_LOW: `The next bid must be at least ${usd(minNextMinor)}`,
      };
      fail(broken, messages[broken], { minNextMinor });
    }
    // Standing instructions are enforced server-side too, and the key's budget cap applies.
    const why = replyAllowed(agent.key.standing as Standing | undefined, amount, await spentTodayMinor(ctx, agent.key._id, now));
    if (why) fail("STANDING_INSTRUCTIONS", `Refused: ${why}`);
    await assertWithinBudget(ctx, agent.key, amount);

    const reasoning = (args.reasoning ?? "").trim().slice(0, 300) || undefined;
    await ctx.db.insert("momentBids", { momentId: moment._id, offerId: offer._id, advertiserId: offer.advertiserId, kind: "bid", amountMinor: amount, at: now, reasoning });
    await ctx.db.patch(offer._id, { bidCount: bidCount + 1, lastBidMinor: amount, replyAmountMinor: amount });
    const closes = extendLive({ now, closesAt: moment.biddingClosesAt!, extensions: moment.extensions ?? 0 });
    await ctx.db.patch(moment._id, { currentMinor: amount, leaderOfferId: offer._id, biddingClosesAt: closes.closesAt, extensions: closes.extensions });
    if (closes.closesAt !== moment.biddingClosesAt) {
      await ctx.scheduler.runAt(closes.closesAt, internal.liveAuction.closeBidding, { momentId: moment._id });
    }
    const company = agent.advertiser.displayName;
    await addMomentStep(
      ctx,
      moment,
      `bid:${offer._id}:${bidCount + 1}`,
      `${company} bids ${usd(amount)}`,
      `${reasoning ?? ""}${closes.closesAt !== moment.biddingClosesAt ? ` Late bid: closing extended ${EXTENSION_MS / 1000} s.` : ""}`.trim() || undefined,
      now,
    );
    await recordAudit(ctx, {
      workspaceId: moment.workspaceId,
      traceId: `moment:${moment._id}`,
      actor: agent.actor,
      type: "moment.reply",
      subjectId: offer._id,
      reason: `bid ${usd(amount)}${reasoning ? `: ${reasoning}` : ""}`.slice(0, 1000),
    });
    await deliverTo(ctx, (await offersOf(ctx, moment._id)).filter(inAuction), "auction_update");
    return { offerId: offer._id, currentMinor: amount, youLead: true, bidsLeft: MAX_BIDS_PER_COMPANY - bidCount - 1, closesAt: closes.closesAt };
  },
});

/**
 * Bidding's (possibly extended) close: the leader wins at its bid. With no
 * bids (R12), the earliest company that accepted the opening price gets it at
 * that price: everyone who joined committed to it, and a sold screen beats an idle one.
 */
export const closeBidding = internalMutation({
  args: { momentId: v.id("moments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const moment = await ctx.db.get(args.momentId);
    if (!moment || moment.status !== "bidding" || Date.now() < (moment.biddingClosesAt ?? 0)) return null;
    if (!moment.leaderOfferId) {
      const first = (await offersOf(ctx, moment._id))
        .filter((o) => o.status === "accepted")
        .sort((a, b) => (a.repliedAt ?? Infinity) - (b.repliedAt ?? Infinity))[0];
      await addMomentStep(ctx, moment, "bidding_closed", "Bidding closed with no bids", `Sold to the earliest company that joined, at the ${usd(moment.priceMinor)} opening price.`);
      if (!first || !(await award(ctx, (await ctx.db.get(moment._id))!, new Set(), first._id))) {
        await endNoTakers(ctx, moment._id, "Auction closed with no bids", "Nobody who joined could be awarded.");
      }
      return null;
    }
    await addMomentStep(ctx, moment, "bidding_closed", `Bidding closed at ${usd(moment.currentMinor ?? moment.priceMinor)}`);
    if (!(await award(ctx, (await ctx.db.get(moment._id))!, new Set(), moment.leaderOfferId))) {
      await endNoTakers(ctx, moment._id, "Nobody could be awarded", "Every bidder's key is inactive or over its budget cap.");
    }
    return null;
  },
});
