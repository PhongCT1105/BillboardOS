import { ConvexError, v, type Infer } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { flashOfferStatus, momentStatus, momentStep, momentTrigger, paymentMode, standingInstructions } from "./schema";
import { recordAudit } from "./lib/audit";
import { authenticateAgent, assertWithinBudget, keyStatus } from "./lib/agentKeys";
import { loadTrailingAudience } from "./lib/audienceWindow";
import { computeScreenPrice } from "./lib/screenPrice";
import { AUDIENCE_BUCKET_MS, PRICING_POLICY_VERSION } from "./lib/pricing";
import { policyOf } from "./lib/negotiation";
import {
  MAX_OFFERS,
  MIN_REMAINING_MS,
  PAY_WINDOW_MS,
  audienceMix,
  campaignFit,
  detect,
  momentSettingsOf,
  proRata,
  rankReplies,
  replyAllowed,
  standingCovers,
  validateMomentSettings,
  validateStanding,
  type Standing,
} from "./lib/moment";
import { addMomentStep, creativeReady } from "./lib/momentHooks";
import { endHold, takeHold } from "./holds";
import { applyVerifiedPayment } from "./payments";
import { requireCustomer, requireWorkspaceMember, resolveWorkspace, workspaceOfBillboard } from "./lib/tenancy";

/**
 * The live moment (ADR 0006): the seller agent notices a relevant crowd,
 * offers the next spot to matching customers' agents, picks a winner within
 * a short window, holds the spot for the winner to pay over x402, and the
 * player starts the pre-approved creative. Every step is timestamped.
 */

const DAY = 24 * 60 * 60_000;
const FLASH_HOLD_TTL_MS = 3 * 60_000;
const MAX_APPROVALS_SCANNED = 100;
const NEXT_SLOT_LOOKAHEAD_MS = 2 * 60 * 60_000;

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

function fail(code: string, message: string, extra: Record<string, string | number> = {}): never {
  throw new ConvexError({ code, message, ...extra });
}

async function liveEvents(ctx: QueryCtx, billboardId: Id<"billboards">, now: number) {
  const events = await ctx.db
    .query("events")
    .withIndex("by_billboard_and_startsAt", (q) => q.eq("billboardId", billboardId).gte("startsAt", now - DAY).lte("startsAt", now))
    .take(20);
  // Most recently recorded first: on ties the newest event explains the crowd.
  return events.filter((e) => e.endsAt > now).sort((a, b) => b._creationTime - a._creationTime);
}

async function activeEvent(ctx: QueryCtx, billboardId: Id<"billboards">, now: number) {
  return (await liveEvents(ctx, billboardId, now))[0] ?? null;
}

async function latestMoment(ctx: QueryCtx, billboardId: Id<"billboards">) {
  return await ctx.db
    .query("moments")
    .withIndex("by_billboard", (q) => q.eq("billboardId", billboardId))
    .order("desc")
    .first();
}

/** Money this key committed in the last 24 h (active + converted holds): the daily budget's "spent". */
export async function spentTodayMinor(ctx: QueryCtx, agentKeyId: Id<"agentKeys">, now: number): Promise<number> {
  let total = 0;
  for (const status of ["active", "converted"] as const) {
    const holds = await ctx.db
      .query("holds")
      .withIndex("by_agentKey_and_status", (q) => q.eq("agentKeyId", agentKeyId).eq("status", status))
      .order("desc")
      .take(200);
    for (const h of holds) if (h._creationTime >= now - DAY) total += h.amountMinor;
  }
  return total;
}

/** The spot: the rest of the current slot (>= 3 min left, available) else the next available slot. */
async function pickSpot(ctx: QueryCtx, billboard: Doc<"billboards">, now: number) {
  const slots = await ctx.db
    .query("slots")
    .withIndex("by_billboard_and_startAt", (q) =>
      q.eq("billboardId", billboard._id).gte("startAt", now - 15 * 60_000).lte("startAt", now + NEXT_SLOT_LOOKAHEAD_MS),
    )
    .take(12);
  for (const s of slots) {
    if (s.endAt - now < MIN_REMAINING_MS || s.state !== "available") continue;
    if (s.auctionId && (await ctx.db.get(s.auctionId))?.status === "open") continue;
    return s;
  }
  return null;
}

type Target = {
  campaign: Doc<"campaigns">;
  key: Doc<"agentKeys">;
  matchScore: number;
  relevantViewers: number;
  simulatedAgent: boolean;
};

/**
 * Customers to offer the spot to: active campaigns with a creative ready on
 * this host's screens, audience match >= threshold, an active agent key with
 * a webhook and the hold + pay scopes, and standing instructions that cover
 * the seller's floor. One offer per company (its best-matching campaign).
 */
async function findTargets(
  ctx: QueryCtx,
  input: { workspaceId: Id<"workspaces">; mix: Record<string, number>; crowd: number; floorMinor: number; minMatch: number; now: number },
): Promise<{ targets: Target[]; skipped: string[] }> {
  const approvals = await ctx.db
    .query("creativeApprovals")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", input.workspaceId))
    .take(MAX_APPROVALS_SCANNED);
  const best = new Map<Id<"advertisers">, Target>();
  const skipped: string[] = [];
  for (const approval of approvals) {
    const campaign = await ctx.db.get(approval.campaignId);
    if (!campaign || campaign.status !== "active") continue;
    const company = (await ctx.db.get(campaign.advertiserId))?.displayName ?? "company";
    if (!(await creativeReady(ctx, campaign, input.workspaceId))) continue;
    const fit = campaignFit(input.mix, campaign.targetAudience, input.crowd);
    if (fit.matchScore < input.minMatch) {
      skipped.push(`${company}: audience match ${Math.round(fit.matchScore * 100)}% < ${Math.round(input.minMatch * 100)}%`);
      continue;
    }
    const keys = await ctx.db
      .query("agentKeys")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", campaign.advertiserId))
      .take(20);
    let chosen: Doc<"agentKeys"> | null = null;
    let reason = "no agent key with a webhook and standing instructions";
    for (const k of keys) {
      if (keyStatus(k, input.now) !== "active" || !k.webhookUrl || !k.standing) continue;
      if (!k.scopes.includes("hold") || !k.scopes.includes("pay")) continue;
      if (k.campaignIds && !k.campaignIds.includes(campaign._id)) continue;
      const why = standingCovers(k.standing, {
        floorMinor: input.floorMinor,
        relevantViewers: fit.relevantViewers,
        spentTodayMinor: await spentTodayMinor(ctx, k._id, input.now),
      });
      if (why) {
        reason = why;
        continue;
      }
      chosen = k;
      break;
    }
    if (!chosen) {
      skipped.push(`${company}: ${reason}`);
      continue;
    }
    const demo = await ctx.db
      .query("demoAgents")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", campaign.advertiserId))
      .first();
    const prev = best.get(campaign.advertiserId);
    if (!prev || fit.matchScore > prev.matchScore) {
      best.set(campaign.advertiserId, {
        campaign,
        key: chosen,
        matchScore: fit.matchScore,
        relevantViewers: fit.relevantViewers,
        simulatedAgent: demo?.agentKeyId === chosen._id,
      });
    }
  }
  const targets = [...best.values()].sort((a, b) => b.matchScore - a.matchScore).slice(0, MAX_OFFERS);
  return { targets, skipped };
}

type DetectResult = { momentId: Id<"moments"> | null; reason: string };

/** Detector + targeting + offers. Returns the new moment, or why nothing happened. */
export async function detectCore(
  ctx: MutationCtx,
  billboardId: Id<"billboards">,
  trigger: Infer<typeof momentTrigger>,
): Promise<DetectResult> {
  const now = Date.now();
  const billboard = await ctx.db.get(billboardId);
  if (!billboard?.workspaceId || billboard.deviceStatus !== "online") return { momentId: null, reason: "screen offline or unassigned" };
  const workspace = (await ctx.db.get(billboard.workspaceId))!;
  const settings = momentSettingsOf(workspace);
  if (!settings.enabled) return { momentId: null, reason: "moment detector is off for this host" };

  const last = await latestMoment(ctx, billboard._id);
  if (last) {
    const busy = last.status === "offering" || last.status === "awarded" || ((last.status === "paid" || last.status === "playing") && last.spotEndAt > now);
    if (busy) return { momentId: null, reason: "a moment is already in progress on this screen" };
    if (trigger !== "simulated" && now - last.startedAt < settings.cooldownMs) {
      return { momentId: null, reason: `cooling down (${Math.round(settings.cooldownMs / 60_000)} min per screen)` };
    }
  }

  const { sample } = await loadTrailingAudience(ctx.db, billboard._id, now);
  // Evaluate each live event (and none); keep the one that explains the most relevant viewers.
  const candidates = [null, ...(await liveEvents(ctx, billboard._id, now))];
  let event: Doc<"events"> | null = null;
  let detection: ReturnType<typeof detect> | null = null;
  for (const e of candidates) {
    const d = detect({
      crowd: sample?.countEstimate ?? 0,
      crowdSimulated: sample?.source === "simulated",
      screenTags: billboard.audienceTags,
      event: e ? { name: e.name, tags: e.audienceTags, uplift: e.upliftMultiplier } : null,
      threshold: settings.minRelevantViewers,
    });
    if (!detection || d.relevantViewers > detection.relevantViewers) {
      detection = d;
      event = e;
    }
  }
  if (!detection) return { momentId: null, reason: "no detection" };
  if (!detection.fires) return { momentId: null, reason: detection.reasoning };

  const slot = await pickSpot(ctx, billboard, now);
  if (!slot) return { momentId: null, reason: `${detection.reasoning}; but no spot is free in the next 2 hours` };
  const spotStartAt = Math.max(now, slot.startAt);
  const covered = slot.endAt - spotStartAt;
  const { price } = await computeScreenPrice(ctx.db, billboard, [slot], now);
  const priceMinor = proRata(price.slotPrices[0].amountMinor, covered);
  const floorRatio = policyOf(workspace).floorRatio;
  const floorMinor = Math.max(1, Math.ceil(priceMinor * floorRatio), Math.ceil((billboard.reserveFloorMinor * covered) / (15 * 60_000)));
  const mix = audienceMix(billboard.audienceTags, event?.audienceTags);
  const { targets, skipped } = await findTargets(ctx, {
    workspaceId: billboard.workspaceId,
    mix,
    crowd: detection.crowd,
    floorMinor,
    minMatch: settings.minMatch,
    now,
  });

  // Automatic triggers stay quiet when nobody can buy; the labeled simulation records why.
  if (targets.length === 0 && trigger !== "simulated") {
    return { momentId: null, reason: `${detection.reasoning}; no eligible customers (${skipped.join("; ") || "no ready creatives"})` };
  }
  const minutes = Math.round(covered / 60_000);
  const offerClosesAt = now + settings.responseWindowMs;
  const momentId = await ctx.db.insert("moments", {
    workspaceId: billboard.workspaceId,
    billboardId: billboard._id,
    trigger,
    status: targets.length > 0 ? "offering" : "no_takers",
    startedAt: now,
    crowd: detection.crowd,
    segment: detection.segment,
    segmentShare: detection.segmentShare,
    relevantViewers: detection.relevantViewers,
    eventName: event?.name,
    crowdSource: sample?.source ?? "none",
    reasoning: detection.reasoning,
    slotId: slot._id,
    spotStartAt,
    spotEndAt: slot.endAt,
    priceMinor,
    floorMinor,
    offerClosesAt,
    steps: [
      { key: "detected", label: "Crowd detected", at: now, detail: detection.reasoning },
      {
        key: "priced",
        label: `${minutes}-minute spot priced at ${usd(priceMinor)}`,
        at: now,
        detail: `${slot.startAt <= now ? "Rest of the current slot" : "Next available slot"}, pro-rata screen price (${minutes} of 15 min).`,
      },
      {
        key: "targeted",
        label: `${targets.length} customer${targets.length === 1 ? "" : "s"} targeted`,
        at: now,
        detail: [
          ...targets.map((t) => `${t.campaign.brief.slice(0, 40)}: ${Math.round(t.matchScore * 100)}% match, ~${t.relevantViewers} relevant`),
          ...skipped.map((s) => `skipped ${s}`),
        ].join("; ").slice(0, 600),
      },
    ],
  });
  await recordAudit(ctx, {
    workspaceId: billboard.workspaceId,
    traceId: `moment:${momentId}`,
    actor: `seller-agent:${workspace.name}`,
    type: "moment.detected",
    subjectId: momentId,
    reason: `${detection.reasoning}; ${minutes}-min spot at ${usd(priceMinor)}; ${targets.length} customer(s) targeted`.slice(0, 1000),
    data: { trigger, crowd: detection.crowd, relevantViewers: detection.relevantViewers, priceMinor, floorMinor },
  });
  const moment = (await ctx.db.get(momentId))!;
  if (targets.length === 0) {
    await addMomentStep(ctx, moment, "no_takers", "No eligible customers", skipped.join("; ") || "No ready creatives for this host.");
    return { momentId, reason: "no eligible customers" };
  }

  for (const t of targets) {
    const offerId = await ctx.db.insert("flashOffers", {
      momentId,
      workspaceId: billboard.workspaceId,
      advertiserId: t.campaign.advertiserId,
      campaignId: t.campaign._id,
      agentKeyId: t.key._id,
      priceMinor,
      relevantViewers: t.relevantViewers,
      matchScore: t.matchScore,
      status: "sent",
      simulatedAgent: t.simulatedAgent,
      delivery: { status: "pending", attempts: 0 },
      sentAt: now,
    });
    await ctx.db.insert("alerts", {
      advertiserId: t.campaign.advertiserId,
      campaignId: t.campaign._id,
      trigger: "flash_offer",
      flashOfferId: offerId,
      billboardId: billboard._id,
      workspaceId: billboard.workspaceId,
      slotIds: [slot._id],
      slots: [{ slotId: slot._id, startAt: spotStartAt, endAt: slot.endAt, screenPriceMinor: priceMinor }],
      matchCount: 1,
      priceMinor,
      reason: `Flash offer from ${workspace.name}: ${minutes} min on ${billboard.name} for ${usd(priceMinor)}, ~${t.relevantViewers} relevant viewers. Reply within ${Math.round(settings.responseWindowMs / 1000)} s.`,
      createdAt: now,
      inbox: { status: "delivered" },
    });
    await ctx.scheduler.runAfter(0, internal.momentDelivery.deliver, { offerId, event: "flash_offer" });
  }
  await addMomentStep(ctx, moment, "offers_sent", `${targets.length} flash offer${targets.length === 1 ? "" : "s"} sent`, `Signed webhooks + inbox; window closes in ${Math.round(settings.responseWindowMs / 1000)} s.`);
  await ctx.scheduler.runAt(offerClosesAt, internal.moments.close, { momentId });
  return { momentId, reason: "offers sent" };
}

/** Event-driven entry point (sensor arrivals, event changes). */
export const detectFor = internalMutation({
  args: { billboardId: v.id("billboards"), trigger: momentTrigger },
  returns: v.object({ momentId: v.union(v.id("moments"), v.null()), reason: v.string() }),
  handler: async (ctx, args) => await detectCore(ctx, args.billboardId, args.trigger),
});

/** Called by the audience and event code: cheap pre-check, then detect in its own transaction. */
export async function scheduleDetect(ctx: MutationCtx, billboardId: Id<"billboards">, trigger: "arrivals" | "event"): Promise<void> {
  const billboard = await ctx.db.get(billboardId);
  if (!billboard?.workspaceId) return;
  const ws = await ctx.db.get(billboard.workspaceId);
  if (!ws || !momentSettingsOf(ws).enabled) return;
  await ctx.scheduler.runAfter(0, internal.moments.detectFor, { billboardId, trigger });
}

/**
 * Host-only, clearly labeled: write a SIMULATED audience bucket of N people
 * for the current 15 minutes, then run the detector (cooldown bypassed, but
 * never while a moment is in progress).
 */
export const simulateCrowd = mutation({
  args: { billboardId: v.id("billboards"), people: v.optional(v.number()) },
  returns: v.object({ momentId: v.union(v.id("moments"), v.null()), reason: v.string() }),
  handler: async (ctx, args) => {
    const member = await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
    const people = args.people ?? 30;
    if (!Number.isSafeInteger(people) || people < 1 || people > 1000) fail("INVALID_INPUT", "people must be 1..1000");
    const now = Date.now();
    const bucketStart = now - (now % AUDIENCE_BUCKET_MS);
    const billboard = (await ctx.db.get(args.billboardId))!;
    const existing = await ctx.db
      .query("audienceAggregates")
      .withIndex("by_billboard_and_bucketStart", (q) => q.eq("billboardId", args.billboardId).eq("bucketStart", bucketStart))
      .first();
    const fields = { countEstimate: people, source: "simulated" as const, confidence: 1, peakInView: Math.max(1, Math.round(people / 4)) };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("audienceAggregates", { workspaceId: billboard.workspaceId, billboardId: args.billboardId, bucketStart, ...fields });
    await recordAudit(ctx, {
      workspaceId: billboard.workspaceId,
      traceId: `billboard:${args.billboardId}`,
      actor: member.actor,
      type: "moment.detected",
      subjectId: args.billboardId,
      reason: `SIMULATED crowd: ${people} people written to the current 15-minute bucket by ${member.email}`,
    });
    return await detectCore(ctx, args.billboardId, "simulated");
  },
});

// ---------------------------------------------------------------- replies (agent API)

/** POST /api/agent/offers/{id}/reply: accept | counter | pass, within the window. */
export const reply = internalMutation({
  args: {
    token: v.string(),
    offerId: v.string(),
    decision: v.union(v.literal("accept"), v.literal("counter"), v.literal("pass")),
    amountMinor: v.optional(v.number()),
    reasoning: v.optional(v.string()),
  },
  returns: v.object({ offerId: v.id("flashOffers"), status: flashOfferStatus, amountMinor: v.union(v.number(), v.null()), windowClosesAt: v.number() }),
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "hold");
    const offerId = ctx.db.normalizeId("flashOffers", args.offerId);
    const offer = offerId ? await ctx.db.get(offerId) : null;
    if (!offer || offer.agentKeyId !== agent.key._id) fail("NOT_FOUND", "Offer not found");
    const moment = (await ctx.db.get(offer.momentId))!;
    const now = Date.now();
    if (moment.status !== "offering" || now >= moment.offerClosesAt) fail("OFFER_CLOSED", "The response window has closed");
    if (offer.status !== "sent") fail("ALREADY_REPLIED", `Already replied: ${offer.status}`);
    let status: "accepted" | "countered" | "passed";
    let amount: number | null = null;
    if (args.decision === "pass") {
      status = "passed";
    } else {
      amount = args.decision === "accept" ? offer.priceMinor : args.amountMinor ?? NaN;
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) fail("INVALID_INPUT", "amountMinor must be whole cents for a counter");
      if (amount >= offer.priceMinor) amount = offer.priceMinor; // countering at/above the ask is an accept
      status = amount === offer.priceMinor ? "accepted" : "countered";
      // Standing instructions are enforced server-side too, and the key's budget cap applies.
      const why = replyAllowed(agent.key.standing as Standing | undefined, amount, await spentTodayMinor(ctx, agent.key._id, now));
      if (why) fail("STANDING_INSTRUCTIONS", `Refused: ${why}`);
      await assertWithinBudget(ctx, agent.key, amount);
    }
    const reasoning = (args.reasoning ?? "").trim().slice(0, 300) || undefined;
    await ctx.db.patch(offer._id, { status, replyAmountMinor: amount ?? undefined, replyReasoning: reasoning, repliedAt: now });
    const company = agent.advertiser.displayName;
    await addMomentStep(
      ctx,
      moment,
      `reply:${offer._id}`,
      `${company}${offer.simulatedAgent ? " (simulated customer agent)" : ""}: ${status === "passed" ? "pass" : status === "accepted" ? `accept ${usd(amount!)}` : `counter ${usd(amount!)}`}`,
      reasoning,
      now,
    );
    await recordAudit(ctx, {
      workspaceId: moment.workspaceId,
      traceId: `moment:${moment._id}`,
      actor: agent.actor,
      type: "moment.reply",
      subjectId: offer._id,
      reason: `${status}${amount !== null ? ` ${usd(amount)}` : ""}${reasoning ? `: ${reasoning}` : ""}`.slice(0, 1000),
    });
    // Close early once everyone answered.
    const offers = await ctx.db
      .query("flashOffers")
      .withIndex("by_moment", (q) => q.eq("momentId", moment._id))
      .take(MAX_OFFERS + 1);
    if (offers.every((o) => o.status !== "sent")) await closeCore(ctx, moment._id, "everyone replied");
    return { offerId: offer._id, status, amountMinor: amount, windowClosesAt: moment.offerClosesAt };
  },
});

// ---------------------------------------------------------------- close, award, default

async function award(ctx: MutationCtx, moment: Doc<"moments">, excludeOfferIds: Set<string>): Promise<boolean> {
  const offers = await ctx.db
    .query("flashOffers")
    .withIndex("by_moment", (q) => q.eq("momentId", moment._id))
    .take(MAX_OFFERS + 1);
  const ranked = rankReplies(
    offers
      .filter((o) => !excludeOfferIds.has(o._id))
      .map((o) => ({ offerId: o._id, status: o.status, amountMinor: o.replyAmountMinor ?? null, repliedAt: o.repliedAt ?? null })),
    moment.floorMinor,
  );
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
        `Flash spot from ${workspace.name}'s seller agent: ${Math.round((moment.spotEndAt - moment.spotStartAt) / 60_000)} min, ask ${usd(moment.priceMinor)}, won at ${usd(amount)}`,
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
      return true; // nothing else can win this slot either
    }
    await ctx.db.patch(offer._id, { status: "won", holdId: hold._id });
    await ctx.db.patch(moment._id, { status: "awarded", winnerOfferId: offer._id, holdId: hold._id });
    await addMomentStep(ctx, moment, "winner", `${company} wins at ${usd(amount)}${offer.simulatedAgent ? " (simulated customer agent)" : ""}`, `Highest acceptable reply at or above the seller's floor; ties go to the earliest.`, now);
    await addMomentStep(ctx, moment, "hold", "Spot held for the winner", `Hold ${hold._id}; pay over x402 within ${PAY_WINDOW_MS / 1000} s.`, now);
    await recordAudit(ctx, {
      workspaceId: moment.workspaceId,
      traceId,
      actor: `seller-agent:${workspace.name}`,
      type: "moment.awarded",
      subjectId: moment._id,
      reason: `Flash spot awarded to ${company} at ${usd(amount)} (ask ${usd(moment.priceMinor)}, floor policy applied); hold ${hold._id}`,
    });
    await ctx.scheduler.runAfter(0, internal.momentDelivery.deliver, { offerId: offer._id, event: "flash_won" });
    for (const o of offers) {
      if (o._id === offer._id || o.status === "lost" || o.status === "defaulted") continue;
      if (o.status === "accepted" || o.status === "countered") {
        await ctx.db.patch(o._id, { status: "lost" });
        await ctx.scheduler.runAfter(0, internal.momentDelivery.deliver, { offerId: o._id, event: "flash_lost" });
      }
    }
    await ctx.scheduler.runAfter(PAY_WINDOW_MS, internal.moments.payDeadline, { momentId: moment._id, offerId: offer._id });
    return true;
  }
  return false;
}

async function closeCore(ctx: MutationCtx, momentId: Id<"moments">, why: string): Promise<void> {
  const moment = await ctx.db.get(momentId);
  if (!moment || moment.status !== "offering") return;
  const offers = await ctx.db
    .query("flashOffers")
    .withIndex("by_moment", (q) => q.eq("momentId", momentId))
    .take(MAX_OFFERS + 1);
  for (const o of offers) if (o.status === "sent") await ctx.db.patch(o._id, { status: "expired" });
  await addMomentStep(ctx, moment, "window_closed", `Window closed: ${why}`);
  const awarded = await award(ctx, moment, new Set());
  if (!awarded) {
    await ctx.db.patch(momentId, { status: "no_takers" });
    await addMomentStep(ctx, moment, "no_takers", "No acceptable replies", `Nothing at or above the seller's floor of ${usd(moment.floorMinor)}.`);
    await recordAudit(ctx, {
      workspaceId: moment.workspaceId,
      traceId: `moment:${momentId}`,
      actor: "system",
      type: "moment.closed",
      subjectId: momentId,
      reason: `No acceptable replies (floor ${usd(moment.floorMinor)})`,
    });
  }
}

/** Scheduled at the end of the response window (no-op if already closed early). */
export const close = internalMutation({
  args: { momentId: v.id("moments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await closeCore(ctx, args.momentId, "time is up");
    return null;
  },
});

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
    if (hold.status === "active") await endHold(ctx, hold, "released", "system", "Flash spot winner did not pay within 60 s");
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
      evidence: `Flash spot winner did not pay ${usd(hold.amountMinor)} within ${PAY_WINDOW_MS / 1000} s (moment ${moment._id}).`,
      nextAction: "Review the buyer agent's standing instructions or wallet; the spot went to the next best offer if any.",
    });
    await addMomentStep(ctx, moment, "defaulted", "Winner did not pay in time", "Hold released; winner_default exception opened; offering the next best reply.");
    await ctx.db.patch(moment._id, { status: "offering", winnerOfferId: undefined, holdId: undefined });
    const excluded = new Set<string>([offer._id]);
    const offers = await ctx.db
      .query("flashOffers")
      .withIndex("by_moment", (q) => q.eq("momentId", moment._id))
      .take(MAX_OFFERS + 1);
    for (const o of offers) if (o.status === "defaulted") excluded.add(o._id);
    const fresh = (await ctx.db.get(moment._id))!;
    // Restore "lost" replies so they can be ranked again.
    for (const o of offers) if (o.status === "lost") await ctx.db.patch(o._id, { status: o.replyAmountMinor === o.priceMinor ? "accepted" : "countered" });
    const awarded = await award(ctx, fresh, excluded);
    if (!awarded) {
      await ctx.db.patch(moment._id, { status: "failed" });
      await addMomentStep(ctx, moment, "failed", "No one left to award", "The spot went back on sale.");
    }
    return null;
  },
});

/** x402 route saw a signed payment for a moment's hold. */
export const markPaymentStarted = internalMutation({
  args: { holdId: v.id("holds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const moment = await ctx.db
      .query("moments")
      .withIndex("by_hold", (q) => q.eq("holdId", args.holdId))
      .first();
    if (!moment || moment.steps.some((s) => s.key === "payment_started")) return null;
    await addMomentStep(ctx, moment, "payment_started", "Payment signed: verifying and settling", "x402 facilitator verify -> re-check hold -> settle on Base Sepolia.");
    return null;
  },
});

/**
 * The winner's agent could not pay (no x402 config or no wallet). Recorded as
 * blocked; never faked. If the host turned on rehearsal settlement, settle the
 * hold with a labeled REHEARSAL (simulated) payment so the flow can be rehearsed.
 */
export const paymentBlocked = internalMutation({
  args: { holdId: v.id("holds"), reason: v.string() },
  returns: v.object({ rehearsal: v.boolean() }),
  handler: async (ctx, args) => {
    const moment = await ctx.db
      .query("moments")
      .withIndex("by_hold", (q) => q.eq("holdId", args.holdId))
      .first();
    if (!moment) return { rehearsal: false };
    const reason = args.reason.slice(0, 200);
    await ctx.db.patch(moment._id, { paymentBlocked: reason });
    await addMomentStep(ctx, moment, "payment_blocked", `Payment blocked: ${reason}`, "No money moved. Nothing is shown as paid without a settlement transaction.");
    const workspace = (await ctx.db.get(moment.workspaceId))!;
    if (!momentSettingsOf(workspace).rehearsalSettlement) return { rehearsal: false };
    const hold = await ctx.db.get(args.holdId);
    if (!hold || hold.status !== "active") return { rehearsal: false };
    await applyVerifiedPayment(
      ctx,
      {
        holdId: hold._id,
        provider: "manual",
        externalRef: `rehearsal:${hold._id}`,
        amountMinor: hold.amountMinor,
        asset: "USD",
        idempotencyKey: `rehearsal:${hold._id}`,
      },
      { actor: "REHEARSAL (simulated) payment", reasonPrefix: "REHEARSAL (simulated) payment, no money moved: " },
    );
    return { rehearsal: true };
  },
});

// ---------------------------------------------------------------- settings (hosts)

export const settingsView = v.object({
  enabled: v.boolean(),
  minRelevantViewers: v.number(),
  cooldownMinutes: v.number(),
  responseWindowSeconds: v.number(),
  minMatch: v.number(),
  rehearsalSettlement: v.boolean(),
});

export const settings = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: settingsView,
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const s = momentSettingsOf((await ctx.db.get(me.workspaceId))!);
    return {
      enabled: s.enabled,
      minRelevantViewers: s.minRelevantViewers,
      cooldownMinutes: Math.round(s.cooldownMs / 60_000),
      responseWindowSeconds: Math.round(s.responseWindowMs / 1000),
      minMatch: s.minMatch,
      rehearsalSettlement: s.rehearsalSettlement,
    };
  },
});

export const updateSettings = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    enabled: v.boolean(),
    minRelevantViewers: v.number(),
    cooldownMinutes: v.number(),
    responseWindowSeconds: v.number(),
    minMatch: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireWorkspaceMember(ctx, args.workspaceId, "owner");
    const s = {
      minRelevantViewers: args.minRelevantViewers,
      cooldownMs: Math.round(args.cooldownMinutes * 60_000),
      responseWindowMs: Math.round(args.responseWindowSeconds * 1000),
      minMatch: args.minMatch,
    };
    const problem = validateMomentSettings(s);
    if (problem) fail("INVALID_INPUT", problem);
    await ctx.db.patch(args.workspaceId, {
      momentEnabled: args.enabled,
      momentMinRelevantViewers: s.minRelevantViewers,
      momentCooldownMs: s.cooldownMs,
      momentResponseWindowMs: s.responseWindowMs,
      momentMinMatch: s.minMatch,
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      traceId: `workspace:${args.workspaceId}`,
      actor: owner.actor,
      type: "workspace.policy_changed",
      subjectId: args.workspaceId,
      reason: `Moment detector ${args.enabled ? "on" : "off"}: ${s.minRelevantViewers}+ relevant viewers, ${args.cooldownMinutes} min cooldown, ${args.responseWindowSeconds}s window, ${Math.round(s.minMatch * 100)}% match`,
    });
    return null;
  },
});

/** Owner-only, OFF by default. When payments are unavailable, settle winners with a labeled REHEARSAL (simulated) payment. */
export const setRehearsalSettlement = mutation({
  args: { workspaceId: v.id("workspaces"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireWorkspaceMember(ctx, args.workspaceId, "owner");
    await ctx.db.patch(args.workspaceId, { rehearsalSettlement: args.enabled });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      traceId: `workspace:${args.workspaceId}`,
      actor: owner.actor,
      type: "workspace.policy_changed",
      subjectId: args.workspaceId,
      reason: `REHEARSAL (simulated) settlement ${args.enabled ? "ON: blocked flash-spot payments are settled as simulated, no money moves" : "OFF"}`,
    });
    return null;
  },
});

// ---------------------------------------------------------------- views

const offerView = v.object({
  offerId: v.id("flashOffers"),
  company: v.string(),
  campaignBrief: v.string(),
  simulatedAgent: v.boolean(),
  priceMinor: v.number(),
  relevantViewers: v.number(),
  matchScore: v.number(),
  status: flashOfferStatus,
  replyAmountMinor: v.union(v.number(), v.null()),
  replyReasoning: v.union(v.string(), v.null()),
  repliedAt: v.union(v.number(), v.null()),
  deliveryStatus: v.string(),
});

export const momentView = v.object({
  momentId: v.id("moments"),
  billboardId: v.id("billboards"),
  billboardName: v.string(),
  locationLabel: v.string(),
  trigger: momentTrigger,
  status: momentStatus,
  startedAt: v.number(),
  crowd: v.number(),
  crowdSource: v.string(),
  segment: v.string(),
  segmentShare: v.number(),
  relevantViewers: v.number(),
  eventName: v.union(v.string(), v.null()),
  reasoning: v.string(),
  spotStartAt: v.number(),
  spotEndAt: v.number(),
  priceMinor: v.number(),
  floorMinor: v.number(),
  offerClosesAt: v.number(),
  winner: v.union(v.object({ company: v.string(), amountMinor: v.number(), simulatedAgent: v.boolean() }), v.null()),
  paidMinor: v.union(v.number(), v.null()),
  paymentMode: v.union(paymentMode, v.null()),
  paymentTx: v.union(v.string(), v.null()),
  paymentNetwork: v.union(v.string(), v.null()),
  paymentBlocked: v.union(v.string(), v.null()),
  firstFrameAt: v.union(v.number(), v.null()),
  durationMs: v.union(v.number(), v.null()),
  steps: v.array(momentStep),
  offers: v.array(offerView),
});

async function viewOf(ctx: QueryCtx, m: Doc<"moments">): Promise<Infer<typeof momentView>> {
  const billboard = await ctx.db.get(m.billboardId);
  const offers = await ctx.db
    .query("flashOffers")
    .withIndex("by_moment", (q) => q.eq("momentId", m._id))
    .take(MAX_OFFERS + 1);
  const views = [];
  let winner: Infer<typeof momentView>["winner"] = null;
  for (const o of offers) {
    const company = (await ctx.db.get(o.advertiserId))?.displayName ?? "Company";
    const brief = (await ctx.db.get(o.campaignId))?.brief ?? "";
    views.push({
      offerId: o._id,
      company,
      campaignBrief: brief,
      simulatedAgent: o.simulatedAgent,
      priceMinor: o.priceMinor,
      relevantViewers: o.relevantViewers,
      matchScore: o.matchScore,
      status: o.status,
      replyAmountMinor: o.replyAmountMinor ?? null,
      replyReasoning: o.replyReasoning ?? null,
      repliedAt: o.repliedAt ?? null,
      deliveryStatus: o.delivery.status,
    });
    if (m.winnerOfferId === o._id) winner = { company, amountMinor: o.replyAmountMinor ?? o.priceMinor, simulatedAgent: o.simulatedAgent };
  }
  return {
    momentId: m._id,
    billboardId: m.billboardId,
    billboardName: billboard?.name ?? "Screen",
    locationLabel: billboard?.locationLabel ?? "",
    trigger: m.trigger,
    status: m.status,
    startedAt: m.startedAt,
    crowd: m.crowd,
    crowdSource: m.crowdSource,
    segment: m.segment,
    segmentShare: m.segmentShare,
    relevantViewers: m.relevantViewers,
    eventName: m.eventName ?? null,
    reasoning: m.reasoning,
    spotStartAt: m.spotStartAt,
    spotEndAt: m.spotEndAt,
    priceMinor: m.priceMinor,
    floorMinor: m.floorMinor,
    offerClosesAt: m.offerClosesAt,
    winner,
    paidMinor: m.paidMinor ?? null,
    paymentMode: m.paymentMode ?? null,
    paymentTx: m.paymentTx ?? null,
    paymentNetwork: m.paymentNetwork ?? null,
    paymentBlocked: m.paymentBlocked ?? null,
    firstFrameAt: m.firstFrameAt ?? null,
    durationMs: m.durationMs ?? null,
    steps: m.steps,
    offers: views,
  };
}

/** Host "Live moment" view: the screen, its live crowd and event, the latest moment, recent history. */
export const live = query({
  args: { billboardId: v.id("billboards"), atMinute: v.number() },
  returns: v.object({
    screen: v.object({
      name: v.string(),
      locationLabel: v.string(),
      city: v.string(),
      normalTrafficPer15Min: v.number(),
      liveCrowd: v.union(v.number(), v.null()),
      liveCrowdSource: v.union(v.string(), v.null()),
      event: v.union(v.object({ name: v.string(), uplift: v.number(), source: v.string() }), v.null()),
    }),
    latest: v.union(momentView, v.null()),
    history: v.array(
      v.object({
        momentId: v.id("moments"),
        startedAt: v.number(),
        status: momentStatus,
        relevantViewers: v.number(),
        winner: v.union(v.string(), v.null()),
        paidMinor: v.union(v.number(), v.null()),
        paymentMode: v.union(paymentMode, v.null()),
        durationMs: v.union(v.number(), v.null()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) fail("NOT_FOUND", "Billboard not found");
    await requireWorkspaceMember(ctx, billboard.workspaceId);
    const at = args.atMinute;
    const { sample } = await loadTrailingAudience(ctx.db, billboard._id, at);
    const event = await activeEvent(ctx, billboard._id, at);
    const rows = await ctx.db
      .query("moments")
      .withIndex("by_billboard", (q) => q.eq("billboardId", billboard._id))
      .order("desc")
      .take(10);
    const history = [];
    for (const m of rows) {
      const win = m.winnerOfferId ? await ctx.db.get(m.winnerOfferId) : null;
      history.push({
        momentId: m._id,
        startedAt: m.startedAt,
        status: m.status,
        relevantViewers: m.relevantViewers,
        winner: win ? ((await ctx.db.get(win.advertiserId))?.displayName ?? null) : null,
        paidMinor: m.paidMinor ?? null,
        paymentMode: m.paymentMode ?? null,
        durationMs: m.durationMs ?? null,
      });
    }
    return {
      screen: {
        name: billboard.name,
        locationLabel: billboard.locationLabel,
        city: billboard.city,
        normalTrafficPer15Min: billboard.audienceBaselinePerBucket ?? 120,
        liveCrowd: sample?.countEstimate ?? null,
        liveCrowdSource: sample?.source ?? null,
        event: event ? { name: event.name, uplift: event.upliftMultiplier, source: event.source } : null,
      },
      latest: rows[0] ? await viewOf(ctx, rows[0]) : null,
      history,
    };
  },
});

/** Customer: what their agents bought in live moments. */
export const myBuys = query({
  args: { advertiserId: v.optional(v.id("advertisers")) },
  returns: v.array(
    v.object({
      offerId: v.id("flashOffers"),
      status: flashOfferStatus,
      billboardName: v.string(),
      minutes: v.number(),
      amountMinor: v.union(v.number(), v.null()),
      relevantViewers: v.number(),
      simulatedAgent: v.boolean(),
      paymentMode: v.union(paymentMode, v.null()),
      paymentTx: v.union(v.string(), v.null()),
      paymentNetwork: v.union(v.string(), v.null()),
      momentStatus,
      at: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx, args.advertiserId);
    const offers = await ctx.db
      .query("flashOffers")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(20);
    const out = [];
    for (const o of offers) {
      const m = (await ctx.db.get(o.momentId))!;
      const mine = m.winnerOfferId === o._id;
      out.push({
        offerId: o._id,
        status: o.status,
        billboardName: (await ctx.db.get(m.billboardId))?.name ?? "Screen",
        minutes: Math.round((m.spotEndAt - m.spotStartAt) / 60_000),
        amountMinor: o.replyAmountMinor ?? null,
        relevantViewers: o.relevantViewers,
        simulatedAgent: o.simulatedAgent,
        paymentMode: mine ? (m.paymentMode ?? null) : null,
        paymentTx: mine ? (m.paymentTx ?? null) : null,
        paymentNetwork: mine ? (m.paymentNetwork ?? null) : null,
        momentStatus: m.status,
        at: o.sentAt,
      });
    }
    return out;
  },
});

/** Customer: set standing instructions on one of their agent keys. */
export const setStanding = mutation({
  args: { agentKeyId: v.id("agentKeys"), standing: v.union(standingInstructions, v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.agentKeyId);
    if (!key) fail("NOT_FOUND", "Agent key not found");
    const customer = await requireCustomer(ctx, key.advertiserId);
    if (args.standing) {
      const problem = validateStanding(args.standing);
      if (problem) fail("INVALID_INPUT", problem);
    }
    await ctx.db.patch(key._id, { standing: args.standing ?? undefined });
    await recordAudit(ctx, {
      traceId: `company:${key.advertiserId}`,
      actor: customer.actor,
      type: "agent_key.created",
      subjectId: key._id,
      reason: args.standing
        ? `Standing instructions on "${key.name}": ${args.standing.policy}, max ${usd(args.standing.maxPricePerSpotMinor)}/spot, ${args.standing.minRelevantViewers}+ relevant viewers, ${usd(args.standing.dailyBudgetMinor)}/day`
        : `Standing instructions cleared on "${key.name}"`,
    });
    return null;
  },
});
