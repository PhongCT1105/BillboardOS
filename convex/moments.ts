import { ConvexError, v, type Infer } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { flashOfferStatus, momentStatus, momentStep, momentTrigger, paymentMode, standingInstructions } from "./schema";
import { recordAudit } from "./lib/audit";
import { authenticateAgent, assertWithinBudget, keyStatus } from "./lib/agentKeys";
import { loadTrailingAudience } from "./lib/audienceWindow";
import { DEFAULT_CPM_MINOR, DEFAULT_LIVE_MINIMUM_MINOR, MAX_JITTER, livePrice, referenceCpm } from "./lib/livePrice";
import { NEGOTIATION_TIME_CAP_MS, NEXT_SPOT_LEAD_MS, REOFFER_DELAY_MS } from "./lib/liveAuction";
import {
  MAX_OFFERS,
  MIN_REMAINING_MS,
  audienceMix,
  campaignFit,
  momentSettingsOf,
  replyAllowed,
  standingCovers,
  validateMomentSettings,
  validateStanding,
  screenModeOf,
  type Standing,
} from "./lib/moment";
import { addMomentStep, creativeReady, releaseWorkspace } from "./lib/momentHooks";
import { closeJoinCore, endStuckMoment, isStuck, negotiationReply, paymentInFlight, stuckAt } from "./liveAuction";
import { requireCustomer, requireWorkspaceMember, resolveWorkspace } from "./lib/tenancy";

/**
 * The live moment (ADR 0006): from the camera's live count the host's
 * pricing agent prices the next spot and announces it to every company whose
 * profile, reach target and limits fit (one live auction per host at a time;
 * other screens queue). The lifecycle after the announcement lives in
 * liveAuction.ts. Every step is timestamped.
 */

const DAY = 24 * 60 * 60_000;
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

/** Agent keys looked at when summing a company's spend today. */
const MAX_COMPANY_KEYS_SCANNED = 200;

/**
 * Money a company committed in the last 24 h across all of its agent keys
 * (active + converted holds): the daily budget's "spent". Counting per company,
 * not per key, means a re-issued key (agent reconfigured or toggled off/on)
 * never gets a fresh daily budget. Keys revoked or expired more than 24 h ago
 * can't hold anything created since, so they are skipped.
 */
export async function spentTodayForAdvertiserMinor(ctx: QueryCtx, advertiserId: Id<"advertisers">, now: number): Promise<number> {
  const keys = await ctx.db
    .query("agentKeys")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .order("desc")
    .take(MAX_COMPANY_KEYS_SCANNED);
  let total = 0;
  for (const k of keys) {
    if ((k.revokedAt !== undefined && k.revokedAt < now - DAY) || k.expiresAt < now - DAY) continue;
    total += await spentTodayMinor(ctx, k._id, now);
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

/** A camera reading counts for this long (by its 15-minute bucket start). */
const READING_MAX_AGE_MS = 15 * 60_000;
/** Moments looked at for the queue check and the screen's sales history. */
const RECENT_MOMENTS = 20;
/** A live auction or negotiation is running, or its winner is paying. */
const BUSY_STATUSES: ReadonlySet<Doc<"moments">["status"]> = new Set(["offering", "bidding", "negotiating", "awarded"]);

/** People in view must move by at least this much (or 20%) to re-price a waiting re-offer. */
const REPRICE_MIN_PEOPLE = 2;
const REPRICE_MIN_SHARE = 0.2;

async function busyMoments(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Doc<"moments">[]> {
  const recent = await ctx.db
    .query("moments")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .order("desc")
    .take(RECENT_MOMENTS);
  return recent.filter((m) => BUSY_STATUSES.has(m.status));
}

/**
 * One live auction (or negotiation) per host at a time: the screen running
 * one (auction, negotiation, or a winner paying), or null when the host is
 * free. A moment clearly past its bound (`stuckAfter`) no longer counts.
 */
export async function workspaceBusy(ctx: QueryCtx, workspaceId: Id<"workspaces">, now = Date.now()): Promise<Id<"billboards"> | null> {
  for (const m of await busyMoments(ctx, workspaceId)) if (!(await isStuck(ctx, m, now))) return m.billboardId;
  return null;
}

/** The host's live moments that are stuck past their bound (their scheduled close never ran). */
export async function stuckMoments(ctx: QueryCtx, workspaceId: Id<"workspaces">, now: number): Promise<Doc<"moments">[]> {
  const out = [];
  for (const m of await busyMoments(ctx, workspaceId)) if (await isStuck(ctx, m, now)) out.push(m);
  return out;
}

/**
 * People in view right now: the newest camera bucket from the last 15
 * minutes, using its peak in view. Simulated rows and older readings never count.
 */
export async function latestCameraReading(
  ctx: QueryCtx,
  billboardId: Id<"billboards">,
  now: number,
): Promise<{ peopleInView: number; bucketStart: number } | null> {
  const rows = await ctx.db
    .query("audienceAggregates")
    .withIndex("by_billboard_and_bucketStart", (q) => q.eq("billboardId", billboardId).gte("bucketStart", now - READING_MAX_AGE_MS))
    .order("desc")
    .take(4);
  const row = rows.find((r) => r.source === "camera");
  return row ? { peopleInView: row.peakInView ?? 0, bucketStart: row.bucketStart } : null;
}

/** The screen's latest moment, how long it has gone without a paid ad, and its reference CPM. */
async function screenHistory(ctx: QueryCtx, billboard: Doc<"billboards">, now: number) {
  const recent = await ctx.db
    .query("moments")
    .withIndex("by_billboard", (q) => q.eq("billboardId", billboard._id))
    .order("desc")
    .take(RECENT_MOMENTS);
  const lastPaid = recent.find((m) => m.paidMinor !== undefined);
  const idleMs = Math.max(0, now - (lastPaid ? lastPaid.spotEndAt : billboard._creationTime));
  const sales = recent
    .filter((m) => m.paidMinor !== undefined && m.impressions !== undefined)
    .reverse() // oldest first
    .map((m) => ({ amountMinor: m.paidMinor!, impressions: m.impressions! }));
  const cpmRefMinor = referenceCpm(sales, billboard.cpmMinor ?? DEFAULT_CPM_MINOR);
  return { latest: recent[0] ?? null, idleMs, cpmRefMinor };
}

/** The biggest audience segment in the mix (a screen without tags is "general"). */
function topSegment(mix: Record<string, number>): { segment: string; share: number } {
  let best = { segment: "general", share: 1 };
  let first = true;
  for (const [segment, share] of Object.entries(mix)) {
    if (first || share > best.share) best = { segment, share };
    first = false;
  }
  return best;
}

type Target = {
  campaign: Doc<"campaigns">;
  key: Doc<"agentKeys">;
  matchScore: number;
  relevantViewers: number;
};

/**
 * Companies to announce the spot to: active campaigns with a creative ready
 * on this host's screens, audience match >= threshold, an active agent key
 * with a webhook and the hold + pay + bid scopes, and standing instructions
 * that cover the published minimum and the company's reach target
 * (relevant viewers = people in view x match). One offer per company: its
 * best-matching campaign.
 */
async function findTargets(
  ctx: QueryCtx,
  input: {
    workspaceId: Id<"workspaces">;
    mix: Record<string, number>;
    peopleInView: number;
    minimumMinor: number;
    minMatch: number;
    now: number;
  },
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
    const fit = campaignFit(input.mix, campaign.targetAudience, input.peopleInView);
    if (fit.matchScore < input.minMatch) {
      skipped.push(`${company}: audience match ${Math.round(fit.matchScore * 100)}% < ${Math.round(input.minMatch * 100)}%`);
      continue;
    }
    const keys = await ctx.db
      .query("agentKeys")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", campaign.advertiserId))
      .take(20);
    let chosen: Doc<"agentKeys"> | null = null;
    let reason = "no agent key with a webhook, the hold, pay and bid scopes, and standing instructions";
    for (const k of keys) {
      if (keyStatus(k, input.now) !== "active" || !k.webhookUrl || !k.standing) continue;
      if (!k.scopes.includes("hold") || !k.scopes.includes("pay") || !k.scopes.includes("bid")) continue;
      if (k.campaignIds && !k.campaignIds.includes(campaign._id)) continue;
      const why = standingCovers(k.standing, {
        floorMinor: input.minimumMinor,
        relevantViewers: fit.relevantViewers,
        spentTodayMinor: await spentTodayForAdvertiserMinor(ctx, k.advertiserId, input.now),
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
    const prev = best.get(campaign.advertiserId);
    if (!prev || fit.matchScore > prev.matchScore) {
      best.set(campaign.advertiserId, { campaign, key: chosen, matchScore: fit.matchScore, relevantViewers: fit.relevantViewers });
    }
  }
  const targets = [...best.values()].sort((a, b) => b.matchScore - a.matchScore).slice(0, MAX_OFFERS);
  return { targets, skipped };
}

type DetectResult = { momentId: Id<"moments"> | null; reason: string };

/** A pending re-offer this far past its due time never ran (it failed): schedule a fresh one. */
const REOFFER_STALE_MS = 10_000;

/**
 * Nobody bought this moment's spot: announce it again after a pause, about
 * 15% lower (the next re-offer round), unless it is already at its minimum,
 * where it holds as a standing offer. One chain per screen: when a re-offer
 * is already pending (`reofferDueAt`), it is left in charge. Returns whether
 * a re-offer is coming.
 */
export async function scheduleReoffer(ctx: MutationCtx, moment: Doc<"moments">): Promise<boolean> {
  if (moment.priceMinor <= moment.floorMinor) return false;
  const now = Date.now();
  const billboard = await ctx.db.get(moment.billboardId);
  if (billboard?.reofferDueAt !== undefined && billboard.reofferDueAt + REOFFER_STALE_MS > now) return true;
  const dueAt = now + REOFFER_DELAY_MS;
  await ctx.db.patch(moment.billboardId, { reofferDueAt: dueAt });
  await ctx.scheduler.runAt(dueAt, internal.moments.detectFor, { billboardId: moment.billboardId, trigger: "reoffer" });
  return true;
}

/**
 * Announce a spot on this screen from the camera's live count: queue behind
 * the host's running auction, price it live, offer it to every company whose
 * profile, reach target and limits fit, or record no takers and re-offer.
 * Returns the new moment, or why nothing happened.
 */
export async function detectCore(
  ctx: MutationCtx,
  billboardId: Id<"billboards">,
  trigger: Infer<typeof momentTrigger>,
): Promise<DetectResult> {
  const now = Date.now();
  const billboard = await ctx.db.get(billboardId);
  if (!billboard?.workspaceId || billboard.deviceStatus !== "online") return { momentId: null, reason: "screen offline or unassigned" };
  const workspaceId = billboard.workspaceId;
  const workspace = (await ctx.db.get(workspaceId))!;
  const settings = momentSettingsOf(workspace);
  if (!settings.enabled) return { momentId: null, reason: "moment detector is off for this host" };

  // A moment stuck past its bound never holds the host forever: end it, then carry on.
  for (const stuck of await stuckMoments(ctx, workspaceId, now)) {
    await endStuckMoment(ctx, stuck, "system", `still ${stuck.status} long past its close; the host lock was released`);
  }
  // One live auction or negotiation per host: other screens wait their turn (first come, first served).
  const busyScreen = await workspaceBusy(ctx, workspaceId, now);
  if (busyScreen === billboard._id) return { momentId: null, reason: "a moment is already in progress on this screen" };
  if (busyScreen !== null) {
    if (billboard.saleQueuedAt === undefined) await ctx.db.patch(billboard._id, { saleQueuedAt: now });
    return { momentId: null, reason: "queued" };
  }

  const history = await screenHistory(ctx, billboard, now);
  const last = history.latest;
  if (last && (last.status === "paid" || last.status === "playing") && last.spotEndAt - now > NEXT_SPOT_LEAD_MS) {
    return { momentId: null, reason: "playing" };
  }

  const reading = await latestCameraReading(ctx, billboard._id, now);
  if (!reading) return { momentId: null, reason: "no camera reading in the last 15 minutes" };
  const peopleInView = reading.peopleInView;
  if (peopleInView < settings.minPeopleInView) {
    return { momentId: null, reason: `${peopleInView} people in view, below the ${settings.minPeopleInView} needed` };
  }

  const slot = await pickSpot(ctx, billboard, now);
  if (!slot) return { momentId: null, reason: `${peopleInView} people in view, but no spot is free in the next 2 hours` };
  const spotStartAt = Math.max(now, slot.startAt);
  const spotMs = slot.endAt - spotStartAt;
  // A spot nobody took is waiting to be re-offered. Only the scheduled re-offer steps the price down;
  // other triggers re-price it at the same round, and only when the crowd really changed.
  const waiting = last?.status === "no_takers" && last.slotId === slot._id ? last : null;
  const stepDown = waiting !== null && trigger === "reoffer";
  if (waiting && !stepDown) {
    const before = waiting.peopleInView ?? waiting.crowd;
    if (Math.abs(peopleInView - before) < Math.max(REPRICE_MIN_PEOPLE, REPRICE_MIN_SHARE * before)) {
      return { momentId: null, reason: "holding" };
    }
  }
  const reofferRound = waiting ? (waiting.reofferRound ?? 0) + (stepDown ? 1 : 0) : 0;
  // A re-price leaves the waiting moment's scheduled re-offer in charge of the next step down.
  const reofferAlreadyScheduled = waiting !== null && !stepDown && waiting.priceMinor > waiting.floorMinor;
  const minimumMinor =
    Number.isSafeInteger(billboard.reserveFloorMinor) && billboard.reserveFloorMinor > 0 ? billboard.reserveFloorMinor : DEFAULT_LIVE_MINIMUM_MINOR;

  const event = await activeEvent(ctx, billboard._id, now);
  const mix = audienceMix(billboard.audienceTags, event?.audienceTags);
  const { targets, skipped } = await findTargets(ctx, {
    workspaceId,
    mix,
    peopleInView,
    minimumMinor,
    minMatch: settings.minMatch,
    now,
  });
  const bestMatch = targets.reduce((m, t) => Math.max(m, t.matchScore), 0);
  const price = livePrice({
    peopleInView,
    spotMs,
    cpmRefMinor: history.cpmRefMinor,
    bestMatch,
    idleMs: history.idleMs,
    msUntilStart: Math.max(0, slot.startAt - now),
    reofferRound,
    minimumMinor,
    jitter: (Math.random() * 2 - 1) * MAX_JITTER,
  });

  const { segment, share } = topSegment(mix);
  const minutes = Math.round(spotMs / 60_000);
  const offering = targets.length > 0;
  const offerClosesAt = offering ? now + settings.joinWindowMs : now;
  const joinSeconds = Math.round(settings.joinWindowMs / 1000);
  const momentId = await ctx.db.insert("moments", {
    workspaceId,
    billboardId: billboard._id,
    trigger,
    status: offering ? "offering" : "no_takers",
    startedAt: now,
    crowd: peopleInView,
    segment,
    segmentShare: share,
    relevantViewers: Math.round(peopleInView * share),
    eventName: event?.name,
    crowdSource: "camera",
    reasoning: price.why,
    slotId: slot._id,
    spotStartAt,
    spotEndAt: slot.endAt,
    priceMinor: price.openingMinor,
    floorMinor: price.minimumMinor,
    valueMinor: price.valueMinor,
    peopleInView,
    plays: price.plays,
    impressions: price.impressions,
    priceWhy: price.why,
    reofferRound,
    offerClosesAt,
    steps: [
      {
        key: "detected",
        label: `${peopleInView} ${peopleInView === 1 ? "person" : "people"} in view`,
        at: now,
        detail: `Camera count${event ? `; ${event.name} next door` : ""}.`,
      },
      {
        key: "priced",
        label: `${minutes}-minute spot: bidding opens at ${usd(price.openingMinor)}`,
        at: now,
        detail: `${slot.startAt <= now ? "Rest of the current slot" : "Next available slot"}. ${price.why}`,
      },
      {
        key: "targeted",
        label: `${targets.length} compan${targets.length === 1 ? "y" : "ies"} targeted`,
        at: now,
        detail: [
          ...targets.map((t) => `${t.campaign.brief.slice(0, 40)}: ${Math.round(t.matchScore * 100)}% match, ~${t.relevantViewers} relevant`),
          ...skipped.map((s) => `skipped ${s}`),
        ].join("; ").slice(0, 600),
      },
    ],
  });
  await recordAudit(ctx, {
    workspaceId,
    traceId: `moment:${momentId}`,
    actor: `seller-agent:${workspace.name}`,
    type: "moment.detected",
    subjectId: momentId,
    reason: `${price.why}; ${targets.length} compan${targets.length === 1 ? "y" : "ies"} targeted`.slice(0, 1000),
    data: {
      trigger,
      peopleInView,
      valueMinor: price.valueMinor,
      openingMinor: price.openingMinor,
      minimumMinor: price.minimumMinor,
      reofferRound,
    },
  });
  // This screen's turn has come: it leaves the queue.
  if (billboard.saleQueuedAt !== undefined) await ctx.db.patch(billboard._id, { saleQueuedAt: undefined });
  const moment = (await ctx.db.get(momentId))!;

  if (!offering) {
    const reoffer = price.openingMinor > price.minimumMinor;
    await addMomentStep(
      ctx,
      moment,
      "no_takers",
      "No eligible companies",
      `${skipped.join("; ") || "No ready creatives for this host."} ${
        !reoffer
          ? `Holding at the ${usd(price.minimumMinor)} minimum.`
          : reofferAlreadyScheduled
            ? "Re-priced for the new crowd; the re-offer already scheduled steps it down about 15%."
            : `Re-offering in ${REOFFER_DELAY_MS / 1000} s, about 15% lower.`
      }`,
    );
    if (!reofferAlreadyScheduled) await scheduleReoffer(ctx, moment);
    await releaseWorkspace(ctx, workspaceId);
    return { momentId, reason: "no eligible customers" };
  }

  for (const t of targets) {
    const offerId = await ctx.db.insert("flashOffers", {
      momentId,
      workspaceId,
      advertiserId: t.campaign.advertiserId,
      campaignId: t.campaign._id,
      agentKeyId: t.key._id,
      priceMinor: price.openingMinor,
      relevantViewers: t.relevantViewers,
      matchScore: t.matchScore,
      status: "sent",
      delivery: { status: "pending", attempts: 0 },
      sentAt: now,
    });
    await ctx.db.insert("alerts", {
      advertiserId: t.campaign.advertiserId,
      campaignId: t.campaign._id,
      trigger: "flash_offer",
      flashOfferId: offerId,
      billboardId: billboard._id,
      workspaceId,
      slotIds: [slot._id],
      slots: [{ slotId: slot._id, startAt: spotStartAt, endAt: slot.endAt, screenPriceMinor: price.openingMinor }],
      matchCount: 1,
      priceMinor: price.openingMinor,
      reason: `Live spot from ${workspace.name}: ${minutes} min on ${billboard.name}, bidding opens at ${usd(price.openingMinor)} (minimum ${usd(price.minimumMinor)}), ~${t.relevantViewers} matching people in view. Join within ${joinSeconds} s.`,
      createdAt: now,
      inbox: { status: "delivered" },
    });
    await ctx.scheduler.runAfter(0, internal.momentDelivery.deliver, { offerId, event: "flash_offer" });
  }
  await addMomentStep(ctx, moment, "offers_sent", `${targets.length} live offer${targets.length === 1 ? "" : "s"} sent`, `Signed webhooks + inbox; joining closes in ${joinSeconds} s.`);
  await ctx.scheduler.runAt(offerClosesAt, internal.liveAuction.closeJoin, { momentId });
  return { momentId, reason: "offers sent" };
}

/** Event-driven entry point (camera arrivals, event changes, queue, re-offers, next spot). */
export const detectFor = internalMutation({
  args: { billboardId: v.id("billboards"), trigger: momentTrigger },
  returns: v.object({ momentId: v.union(v.id("moments"), v.null()), reason: v.string() }),
  handler: async (ctx, args) => {
    if (args.trigger === "reoffer") {
      // The pending re-offer is running now: the screen has no chain until this run schedules one.
      const screen = await ctx.db.get(args.billboardId);
      if (screen?.reofferDueAt !== undefined) await ctx.db.patch(args.billboardId, { reofferDueAt: undefined });
    }
    const result = await detectCore(ctx, args.billboardId, args.trigger);
    if (args.trigger === "queue" && result.momentId === null && !HOST_BUSY_REASONS.has(result.reason)) {
      // A re-offer that came due while the host was busy queued instead: restart its chain
      // (scheduleReoffer leaves a still-pending one in charge).
      if (result.reason === "holding") {
        const waiting = await ctx.db
          .query("moments")
          .withIndex("by_billboard", (q) => q.eq("billboardId", args.billboardId))
          .order("desc")
          .first();
        if (waiting) await scheduleReoffer(ctx, waiting);
      }
      // This screen doesn't sell after all: it leaves the queue and passes its turn on (the host is still free).
      const billboard = await ctx.db.get(args.billboardId);
      if (billboard?.saleQueuedAt !== undefined) await ctx.db.patch(billboard._id, { saleQueuedAt: undefined });
      if (billboard?.workspaceId) await releaseWorkspace(ctx, billboard.workspaceId);
    }
    return result;
  },
});

/** detectCore reasons that mean the host is running a moment (so the queue must wait). */
const HOST_BUSY_REASONS = new Set(["queued", "a moment is already in progress on this screen"]);

/** Called by the audience and event code: cheap pre-check, then detect in its own transaction. */
export async function scheduleDetect(ctx: MutationCtx, billboardId: Id<"billboards">, trigger: "arrivals" | "event"): Promise<void> {
  const billboard = await ctx.db.get(billboardId);
  if (!billboard?.workspaceId) return;
  const ws = await ctx.db.get(billboard.workspaceId);
  if (!ws || !momentSettingsOf(ws).enabled) return;
  await ctx.scheduler.runAfter(0, internal.moments.detectFor, { billboardId, trigger });
}

// ---------------------------------------------------------------- replies (agent API)

/**
 * POST /api/agent/offers/{id}/reply: accept | counter | pass. While the join
 * window is open it joins (or passes on) the live auction; during a
 * negotiation it answers the host's counter-offer.
 */
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
    const reasoning = (args.reasoning ?? "").trim().slice(0, 300) || undefined;
    const company = agent.advertiser.displayName;

    /** Whole cents, within the key's standing instructions and budget cap. */
    async function checkAmount(amount: number): Promise<void> {
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) fail("INVALID_INPUT", "amountMinor must be whole cents for a counter");
      const why = replyAllowed(agent.key.standing as Standing | undefined, amount, await spentTodayForAdvertiserMinor(ctx, agent.key.advertiserId, now));
      if (why) fail("STANDING_INSTRUCTIONS", `Refused: ${why}`);
      await assertWithinBudget(ctx, agent.key, amount);
    }

    if (moment.status === "negotiating") {
      const respondBy = moment.startedAt + NEGOTIATION_TIME_CAP_MS;
      if (moment.negotiationOfferId !== offer._id || now >= respondBy) fail("OFFER_CLOSED", "The negotiation is not open to you");
      const sellerMinor = moment.sellerMinor ?? moment.priceMinor;
      let decision = args.decision;
      let amount: number | null = null;
      if (decision !== "pass") {
        amount = decision === "accept" ? sellerMinor : (args.amountMinor ?? NaN);
        if (Number.isSafeInteger(amount) && amount >= sellerMinor) {
          // Countering at or above the host's price is an accept at the host's price.
          decision = "accept";
          amount = sellerMinor;
        }
        await checkAmount(amount);
      }
      await negotiationReply(ctx, moment, offer, decision, amount ?? undefined, reasoning);
      await recordAudit(ctx, {
        workspaceId: moment.workspaceId,
        traceId: `moment:${moment._id}`,
        actor: agent.actor,
        type: "moment.reply",
        subjectId: offer._id,
        reason: `negotiation ${decision}${amount !== null ? ` ${usd(amount)}` : ""}${reasoning ? `: ${reasoning}` : ""}`.slice(0, 1000),
      });
      const after = (await ctx.db.get(offer._id))!;
      return { offerId: offer._id, status: after.status, amountMinor: amount, windowClosesAt: respondBy };
    }

    if (moment.status !== "offering" || now >= moment.offerClosesAt) fail("OFFER_CLOSED", "The response window has closed");
    if (offer.status !== "sent") fail("ALREADY_REPLIED", `Already replied: ${offer.status}`);
    let status: "accepted" | "countered" | "passed";
    let amount: number | null = null;
    if (args.decision === "pass") {
      status = "passed";
    } else {
      amount = args.decision === "accept" ? offer.priceMinor : args.amountMinor ?? NaN;
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) fail("INVALID_INPUT", "amountMinor must be whole cents for a counter");
      if (amount >= offer.priceMinor) amount = offer.priceMinor; // countering at/above the opening price is an accept
      status = amount === offer.priceMinor ? "accepted" : "countered";
      await checkAmount(amount);
    }
    await ctx.db.patch(offer._id, { status, replyAmountMinor: amount ?? undefined, replyReasoning: reasoning, repliedAt: now });
    await addMomentStep(
      ctx,
      moment,
      `reply:${offer._id}`,
      `${company}: ${status === "passed" ? "pass" : status === "accepted" ? `accept ${usd(amount!)}` : `counter ${usd(amount!)}`}`,
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
    // Close the join window early once everyone answered.
    const offers = await ctx.db
      .query("flashOffers")
      .withIndex("by_moment", (q) => q.eq("momentId", moment._id))
      .take(MAX_OFFERS + 1);
    if (offers.every((o) => o.status !== "sent")) await closeJoinCore(ctx, moment._id, "everyone replied");
    return { offerId: offer._id, status, amountMinor: amount, windowClosesAt: moment.offerClosesAt };
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
    const hold = await ctx.db.get(args.holdId);
    // Once per hold (a runner-up's payment gets its own step).
    if (!moment || !hold || moment.steps.some((s) => s.key === "payment_started" && s.at >= hold._creationTime)) return null;
    await addMomentStep(ctx, moment, "payment_started", "Payment signed: verifying and settling", "x402 facilitator verify -> re-check hold -> settle on Base Sepolia.");
    return null;
  },
});

/**
 * The winner's agent could not pay (no x402 config or no wallet). Recorded as
 * blocked; never faked. Nothing is shown as paid without a settlement transaction.
 */
export const paymentBlocked = internalMutation({
  args: { holdId: v.id("holds"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const moment = await ctx.db
      .query("moments")
      .withIndex("by_hold", (q) => q.eq("holdId", args.holdId))
      .first();
    if (!moment) return null;
    // Only while the winner can still pay: a late or repeated report never touches a paid (or moved-on) moment.
    const blockedHold = await ctx.db.get(args.holdId);
    if (moment.status !== "awarded" || !blockedHold || blockedHold.status !== "active") return null;
    // Another attempt is still settling: it isn't blocked (yet).
    if (await paymentInFlight(ctx, moment, blockedHold, Date.now())) return null;
    const reason = args.reason.slice(0, 200);
    await ctx.db.patch(moment._id, { paymentBlocked: reason });
    await addMomentStep(ctx, moment, "payment_blocked", `Payment blocked: ${reason}`, "No money moved. Nothing is shown as paid without a settlement transaction.");
    return null;
  },
});

/**
 * Host: end a live moment that is stuck past its bound (its scheduled close
 * never ran), so the host's queue moves again. Workspace members only; a
 * moment still within its bound, or settling a payment, is left alone.
 */
export const endStuck = mutation({
  args: { momentId: v.id("moments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const moment = await ctx.db.get(args.momentId);
    if (!moment) fail("NOT_FOUND", "Moment not found");
    const member = await requireWorkspaceMember(ctx, moment.workspaceId);
    if (!(await isStuck(ctx, moment, Date.now()))) fail("NOT_STUCK", "This moment is still running (or settling a payment); it ends on its own");
    await endStuckMoment(ctx, moment, member.actor, `ended by the host (${member.actor})`);
    return null;
  },
});

// ---------------------------------------------------------------- settings (hosts)

export const settingsView = v.object({
  enabled: v.boolean(),
  minPeopleInView: v.number(),
  joinWindowSeconds: v.number(),
  minMatch: v.number(),
});

export const settings = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: settingsView,
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const s = momentSettingsOf((await ctx.db.get(me.workspaceId))!);
    return {
      enabled: s.enabled,
      minPeopleInView: s.minPeopleInView,
      joinWindowSeconds: Math.round(s.joinWindowMs / 1000),
      minMatch: s.minMatch,
    };
  },
});

export const updateSettings = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    enabled: v.boolean(),
    minPeopleInView: v.number(),
    joinWindowSeconds: v.number(),
    minMatch: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireWorkspaceMember(ctx, args.workspaceId, "owner");
    const s = {
      minPeopleInView: args.minPeopleInView,
      joinWindowMs: Math.round(args.joinWindowSeconds * 1000),
      minMatch: args.minMatch,
    };
    const problem = validateMomentSettings(s);
    if (problem) fail("INVALID_INPUT", problem);
    await ctx.db.patch(args.workspaceId, {
      momentEnabled: args.enabled,
      momentMinPeopleInView: s.minPeopleInView,
      momentResponseWindowMs: s.joinWindowMs,
      momentMinMatch: s.minMatch,
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      traceId: `workspace:${args.workspaceId}`,
      actor: owner.actor,
      type: "workspace.policy_changed",
      subjectId: args.workspaceId,
      reason: `Moment detector ${args.enabled ? "on" : "off"}: ${s.minPeopleInView}+ people in view, ${args.joinWindowSeconds}s join window, ${Math.round(s.minMatch * 100)}% match`,
    });
    return null;
  },
});

// ---------------------------------------------------------------- views

const screenMode = v.union(
  v.literal("announce"),
  v.literal("auction"),
  v.literal("negotiation"),
  v.literal("settling"),
  v.literal("playing"),
  v.literal("your_ad_here"),
);

const offerView = v.object({
  offerId: v.id("flashOffers"),
  company: v.string(),
  campaignBrief: v.string(),
  priceMinor: v.number(),
  relevantViewers: v.number(),
  matchScore: v.number(),
  status: flashOfferStatus,
  replyAmountMinor: v.union(v.number(), v.null()),
  replyReasoning: v.union(v.string(), v.null()),
  repliedAt: v.union(v.number(), v.null()),
  deliveryStatus: v.string(),
});

const bidView = v.object({
  offerId: v.id("flashOffers"),
  company: v.string(),
  kind: v.union(v.literal("bid"), v.literal("buyer_offer"), v.literal("seller_counter")),
  amountMinor: v.number(),
  at: v.number(),
  reasoning: v.union(v.string(), v.null()),
});

/** Bids shown on the presenter timeline. */
const MAX_BIDS_SHOWN = 100;

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
  winner: v.union(v.object({ company: v.string(), amountMinor: v.number() }), v.null()),
  paidMinor: v.union(v.number(), v.null()),
  paymentMode: v.union(paymentMode, v.null()),
  paymentTx: v.union(v.string(), v.null()),
  paymentNetwork: v.union(v.string(), v.null()),
  paymentBlocked: v.union(v.string(), v.null()),
  firstFrameAt: v.union(v.number(), v.null()),
  durationMs: v.union(v.number(), v.null()),
  steps: v.array(momentStep),
  offers: v.array(offerView),
  /** What the pricing agent thought the spot is worth, and why (null on moments before live pricing). */
  valueMinor: v.union(v.number(), v.null()),
  priceWhy: v.union(v.string(), v.null()),
  biddingClosesAt: v.union(v.number(), v.null()),
  extensions: v.number(),
  /** When this moment counts as stuck (the presenter may then end it); null when it never blocks the host. */
  stuckAfter: v.union(v.number(), v.null()),
  /** Every bid, counter and buyer offer, oldest first. */
  bids: v.array(bidView),
});

async function viewOf(ctx: QueryCtx, m: Doc<"moments">): Promise<Infer<typeof momentView>> {
  const billboard = await ctx.db.get(m.billboardId);
  const offers = await ctx.db
    .query("flashOffers")
    .withIndex("by_moment", (q) => q.eq("momentId", m._id))
    .take(MAX_OFFERS + 1);
  const views = [];
  let winner: Infer<typeof momentView>["winner"] = null;
  const names = new Map<Id<"advertisers">, string>();
  for (const o of offers) {
    const company = (await ctx.db.get(o.advertiserId))?.displayName ?? "Company";
    names.set(o.advertiserId, company);
    const brief = (await ctx.db.get(o.campaignId))?.brief ?? "";
    views.push({
      offerId: o._id,
      company,
      campaignBrief: brief,
      priceMinor: o.priceMinor,
      relevantViewers: o.relevantViewers,
      matchScore: o.matchScore,
      status: o.status,
      replyAmountMinor: o.replyAmountMinor ?? null,
      replyReasoning: o.replyReasoning ?? null,
      repliedAt: o.repliedAt ?? null,
      deliveryStatus: o.delivery.status,
    });
    if (m.winnerOfferId === o._id) winner = { company, amountMinor: o.replyAmountMinor ?? o.priceMinor };
  }
  const bidRows = await ctx.db
    .query("momentBids")
    .withIndex("by_moment", (q) => q.eq("momentId", m._id))
    .take(MAX_BIDS_SHOWN);
  const bids = [];
  for (const b of bidRows) {
    if (!names.has(b.advertiserId)) names.set(b.advertiserId, (await ctx.db.get(b.advertiserId))?.displayName ?? "Company");
    bids.push({
      offerId: b.offerId,
      company: names.get(b.advertiserId)!,
      kind: b.kind,
      amountMinor: b.amountMinor,
      at: b.at,
      reasoning: b.reasoning ?? null,
    });
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
    valueMinor: m.valueMinor ?? null,
    priceWhy: m.priceWhy ?? null,
    biddingClosesAt: m.biddingClosesAt ?? null,
    extensions: m.extensions ?? 0,
    stuckAfter: await stuckAt(ctx, m),
    bids,
  };
}

const MAX_DEVICES = 50;

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
    devices: v.array(
      v.object({
        billboardId: v.id("billboards"),
        name: v.string(),
        online: v.boolean(),
        peopleInView: v.union(v.number(), v.null()),
        mode: screenMode,
        /** End of the screen's latest spot; the client expires "playing" with its own clock. */
        spotEndAt: v.union(v.number(), v.null()),
      }),
    ),
    queue: v.array(v.object({ billboardId: v.id("billboards"), name: v.string(), queuedAt: v.number() })),
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
    const workspaceId = billboard.workspaceId!;
    const screens = await ctx.db
      .query("billboards")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .take(MAX_DEVICES);
    const devices = [];
    for (const s of screens) {
      const last = await ctx.db
        .query("moments")
        .withIndex("by_billboard", (q) => q.eq("billboardId", s._id))
        .order("desc")
        .first();
      devices.push({
        billboardId: s._id,
        name: s.name,
        online: s.deviceStatus === "online",
        peopleInView: (await latestCameraReading(ctx, s._id, args.atMinute))?.peopleInView ?? null,
        mode: screenModeOf(last?.status ?? null),
        spotEndAt: last?.spotEndAt ?? null,
      });
    }
    const queue = screens
      .filter((s) => s.saleQueuedAt !== undefined)
      .sort((a, b) => a.saleQueuedAt! - b.saleQueuedAt!)
      .map((s) => ({ billboardId: s._id, name: s.name, queuedAt: s.saleQueuedAt! }));
    return {
      devices,
      queue,
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
        simulatedAgent: o.simulatedAgent ?? false,
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
