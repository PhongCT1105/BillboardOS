import { ConvexError, v, type Infer } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { slotState } from "./schema";
import { autopilotLogKind, forwardBand, forwardForecast, forwardOfferStatus } from "./lib/autopilotSchema";
import { assertWithinBudget, authenticateAgent, keyStatus } from "./lib/agentKeys";
import { DEFAULT_CPM_MINOR, DEFAULT_LIVE_MINIMUM_MINOR, referenceCpm } from "./lib/livePrice";
import { forecastSlot, type CameraPoint, type Forecast, type ForecastEvent } from "./lib/forecast";
import {
  AUCTION_LEAD_MS,
  FIRST_LOOK_MS,
  HORIZON_MS,
  LIVE_HANDOFF_MS,
  bandOf,
  clockLabel,
  companyFit,
  decideInterest,
  firstLookApplies,
  forwardPrice,
  forwardValue,
  joinNames,
  leadLabel,
  shouldRenotify,
  slotLabel,
  usd,
  withinLimits,
  type Band,
  type CompanyLimits,
} from "./lib/autopilot";
import { momentSettingsOf, replyAllowed, type Standing } from "./lib/moment";
import { creativeReady } from "./lib/momentHooks";
import { PRICING_POLICY_VERSION } from "./lib/pricing";
import { QUOTE_TTL_MS } from "./lib/constants";
import { requireWorkspaceMember, resolveWorkspace } from "./lib/tenancy";
import { takeHold } from "./holds";
import { spentTodayForAdvertiserMinor } from "./moments";

/**
 * Host autopilot (ADR 0007 §1): the seller agent fills the next 12 hours.
 *
 * Every minute (crons.ts) and on events (`requestPlan`), `plan` reviews each
 * unsold upcoming slot on each of the workspace's screens:
 *   - under 15 min: left to the live auction (moments.ts / liveAuction.ts);
 *   - 15 min - 2 h: a forward offer at the forecast price, decaying toward
 *     the floor as the slot nears unsold;
 *   - 2 - 12 h: an early-booking price, a little under the forecast price,
 *     raised as the forecast or demand rises.
 * Each offer goes (signed webhook, `forward_offer`) to every company agent
 * whose profile, reach target and limits fit. When two or more companies are
 * offered a slot that can still be auctioned, their yeses are collected for
 * 15 s (the first look): one yes gets the hold, two or more open a scheduled
 * ascending auction (auctions.openIfHot, no button). After that the offer is
 * first come, first served. Every decision is written to `autopilotLog`.
 *
 * Paying: an accepted offer is a normal hold at the offer price, paid over
 * the existing x402 purchase route (POST /a2a/hosts/{workspace}/purchases/{hold}).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_SCREENS = 20;
const MAX_SLOTS_PER_SCREEN = 60;
const MAX_OFFERS_PER_SCREEN = 400;
const MAX_APPROVALS = 100;
const MAX_KEYS = 20;
/** Offers notified per plan run (nearest slots first); the rest go out on the next runs. */
const NOTIFY_PER_RUN = 12;
/** Early-band offers logged one by one per screen per run; more are summarized in one line. */
const LOG_EACH_UP_TO = 3;
/** Event-driven plans closer together than this are merged. */
const PLAN_DEBOUNCE_MS = 5_000;
const LOG_SHOWN = 30;

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function siteUrl(): string {
  return (process.env.CONVEX_SITE_URL ?? "https://billboardos.invalid").replace(/\/$/, "");
}

export function purchaseUrlFor(workspaceId: Id<"workspaces">, holdId: Id<"holds">): string {
  return `${siteUrl()}/a2a/hosts/${workspaceId}/purchases/${holdId}`;
}

// ---------------------------------------------------------------- settings, log, hooks

async function settingsOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Doc<"autopilotSettings"> | null> {
  return await ctx.db
    .query("autopilotSettings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .first();
}

/** On unless the owner paused it (ADR 0007: on by default). */
export async function autopilotEnabled(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  return (await settingsOf(ctx, workspaceId))?.enabled ?? true;
}

async function upsertSettings(ctx: MutationCtx, workspaceId: Id<"workspaces">, patch: Partial<Doc<"autopilotSettings">>): Promise<void> {
  const row = await settingsOf(ctx, workspaceId);
  if (row) await ctx.db.patch(row._id, patch);
  else await ctx.db.insert("autopilotSettings", { workspaceId, enabled: true, ...patch });
}

async function log(
  ctx: MutationCtx,
  entry: {
    workspaceId: Id<"workspaces">;
    kind: Infer<typeof autopilotLogKind>;
    text: string;
    billboardId?: Id<"billboards">;
    slotId?: Id<"slots">;
    offerId?: Id<"forwardOffers">;
  },
): Promise<void> {
  await ctx.db.insert("autopilotLog", { ...entry, text: entry.text.slice(0, 600), at: Date.now() });
}

/**
 * Event hook (new screen or slots, event change, slot freed, crowd change):
 * plan this workspace again soon. Debounced; a no-op while paused.
 */
export async function requestPlan(ctx: MutationCtx, workspaceId: Id<"workspaces"> | undefined, reason: string): Promise<void> {
  if (!workspaceId) return;
  const row = await settingsOf(ctx, workspaceId);
  if (row && !row.enabled) return;
  const now = Date.now();
  if (row?.planRequestedAt !== undefined && now - row.planRequestedAt < PLAN_DEBOUNCE_MS) return;
  await upsertSettings(ctx, workspaceId, { planRequestedAt: now });
  await ctx.scheduler.runAfter(1_000, internal.autopilot.plan, { workspaceId, reason: reason.slice(0, 100) });
}

// ---------------------------------------------------------------- loading what the plan needs

type Company = CompanyLimits & {
  advertiserId: Id<"advertisers">;
  key: Doc<"agentKeys">;
  campaigns: Doc<"campaigns">[];
};

/** The company's agent key for selling ahead: active, hold + pay scopes, standing instructions, this campaign allowed. */
async function sellingKey(ctx: QueryCtx, advertiserId: Id<"advertisers">, campaignId: Id<"campaigns">, now: number): Promise<Doc<"agentKeys"> | null> {
  const agent = await ctx.db
    .query("companyAgents")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .first();
  const keys = await ctx.db
    .query("agentKeys")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .order("desc")
    .take(MAX_KEYS);
  // The company's own server-run agent first, then any other key that can buy.
  keys.sort((a, b) => Number(b._id === agent?.agentKeyId) - Number(a._id === agent?.agentKeyId));
  for (const k of keys) {
    if (keyStatus(k, now) !== "active" || !k.standing) continue;
    if (!k.scopes.includes("hold") || !k.scopes.includes("pay")) continue;
    if (k.campaignIds && !k.campaignIds.includes(campaignId)) continue;
    return k;
  }
  return null;
}

/**
 * Companies that can buy on this host's screens: an active campaign whose
 * creative this host approved, and an agent key with a webhook, the hold and
 * pay scopes and standing instructions. One entry per company.
 */
async function loadCompanies(ctx: QueryCtx, workspaceId: Id<"workspaces">, now: number): Promise<Company[]> {
  const approvals = await ctx.db
    .query("creativeApprovals")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_APPROVALS);
  const byCompany = new Map<Id<"advertisers">, Company>();
  for (const a of approvals) {
    const campaign = await ctx.db.get(a.campaignId);
    if (!campaign || campaign.status !== "active") continue;
    if (!(await creativeReady(ctx, campaign, workspaceId))) continue;
    const existing = byCompany.get(campaign.advertiserId);
    if (existing) {
      if (!existing.key.campaignIds || existing.key.campaignIds.includes(campaign._id)) existing.campaigns.push(campaign);
      continue;
    }
    const key = await sellingKey(ctx, campaign.advertiserId, campaign._id, now);
    if (!key?.webhookUrl || !key.standing) continue;
    const advertiser = await ctx.db.get(campaign.advertiserId);
    const spent = await spentTodayForAdvertiserMinor(ctx, campaign.advertiserId, now);
    byCompany.set(campaign.advertiserId, {
      advertiserId: campaign.advertiserId,
      company: advertiser?.displayName ?? "Company",
      key,
      campaigns: [campaign],
      targetAudience: campaign.targetAudience,
      minRelevantViewers: key.standing.minRelevantViewers,
      maxPerSpotMinor: key.standing.maxPricePerSpotMinor,
      budgetLeftMinor: Math.max(0, key.standing.dailyBudgetMinor - spent),
    });
  }
  return [...byCompany.values()];
}

type Screen = {
  billboard: Doc<"billboards">;
  camera: CameraPoint[];
  events: ForecastEvent[];
  cpmRefMinor: number;
  floorMinor: number;
};

/** Camera history (counts only), events near the next 12 h, the reference CPM and the floor for one screen. */
async function loadScreen(ctx: QueryCtx, billboard: Doc<"billboards">, now: number): Promise<Screen> {
  const rows = await ctx.db
    .query("audienceAggregates")
    .withIndex("by_billboard_and_bucketStart", (q) => q.eq("billboardId", billboard._id).gte("bucketStart", now - DAY).lte("bucketStart", now))
    .take(200);
  // Only real camera counts: legacy simulated rows never feed the forecast.
  const camera = rows
    .filter((r) => r.source === "camera" && r.peakInView !== undefined)
    .map((r) => ({ bucketStart: r.bucketStart, peakInView: r.peakInView! }));
  const eventRows = await ctx.db
    .query("events")
    .withIndex("by_billboard_and_startsAt", (q) => q.eq("billboardId", billboard._id).gte("startsAt", now - DAY).lte("startsAt", now + HORIZON_MS + HOUR))
    .take(50);
  const events = eventRows
    .filter((e) => e.endsAt > now)
    .map((e) => ({
      name: e.name,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      upliftMultiplier: e.upliftMultiplier,
      confidence: e.confidence,
      audienceTags: e.audienceTags,
    }));
  const recent = await ctx.db
    .query("moments")
    .withIndex("by_billboard", (q) => q.eq("billboardId", billboard._id))
    .order("desc")
    .take(20);
  const sales = recent
    .filter((m) => m.paidMinor !== undefined && m.impressions !== undefined)
    .reverse()
    .map((m) => ({ amountMinor: m.paidMinor!, impressions: m.impressions! }));
  const floorMinor =
    Number.isSafeInteger(billboard.reserveFloorMinor) && billboard.reserveFloorMinor > 0 ? billboard.reserveFloorMinor : DEFAULT_LIVE_MINIMUM_MINOR;
  return { billboard, camera, events, cpmRefMinor: referenceCpm(sales, billboard.cpmMinor ?? DEFAULT_CPM_MINOR), floorMinor };
}

type Target = Infer<typeof forwardTargetValidator>;
const forwardTargetValidator = v.object({
  advertiserId: v.id("advertisers"),
  campaignId: v.id("campaigns"),
  agentKeyId: v.id("agentKeys"),
  company: v.string(),
  matchScore: v.number(),
  relevantViewers: v.number(),
});

type Evaluation = {
  band: Band;
  forecast: Forecast;
  valueMinor: number;
  relevance: number;
  priceMinor: number;
  rule: string;
  targets: Target[];
  skipped: string[];
};

/** Forecast, value, price and the companies that would want it at that price, for one slot. */
function evaluate(
  screen: Screen,
  slot: Doc<"slots">,
  companies: Company[],
  minMatch: number,
  now: number,
  opts: { band?: Band; priceMsUntil?: number } = {},
): Evaluation {
  const msUntil = opts.priceMsUntil ?? slot.startAt - now;
  const band = opts.band ?? bandOf(msUntil);
  const forecast = forecastSlot({
    slotStartAt: slot.startAt,
    slotEndAt: slot.endAt,
    now,
    utcOffsetMinutes: screen.billboard.utcOffsetMinutes,
    normalTrafficPer15: screen.billboard.audienceBaselinePerBucket,
    camera: screen.camera,
    events: screen.events,
    screenTags: screen.billboard.audienceTags,
  });
  // Each company's best campaign for this crowd; profile and reach target first, price after.
  const fits: { c: Company; campaign: Doc<"campaigns">; matchScore: number; relevantViewers: number }[] = [];
  const skipped: string[] = [];
  for (const c of companies) {
    let best: { campaign: Doc<"campaigns">; matchScore: number; relevantViewers: number } | null = null;
    let why: string | null = null;
    for (const campaign of c.campaigns) {
      const fit = companyFit(forecast.tags, forecast.expectedPeople, minMatch, { ...c, targetAudience: campaign.targetAudience });
      if (!fit.fits) {
        why ??= fit.why;
        continue;
      }
      if (!best || fit.matchScore > best.matchScore) best = { campaign, matchScore: fit.matchScore, relevantViewers: fit.relevantViewers };
    }
    if (best) fits.push({ c, ...best });
    else skipped.push(`${c.company}: ${why ?? "no fitting campaign"}`);
  }
  const bestMatch = fits.reduce((m, f) => Math.max(m, f.matchScore), 0);
  const value = forwardValue({
    expectedPeople: forecast.expectedPeople,
    slotMs: slot.endAt - slot.startAt,
    cpmRefMinor: screen.cpmRefMinor,
    bestMatch,
    floorMinor: screen.floorMinor,
  });
  const preliminary = fits.filter((f) => withinLimits(f.c, screen.floorMinor) === null).length;
  const price = forwardPrice({ band, valueMinor: value.valueMinor, floorMinor: screen.floorMinor, msUntilStart: msUntil, interested: preliminary });
  const targets: Target[] = [];
  for (const f of fits) {
    const why = withinLimits(f.c, price.priceMinor);
    if (why) {
      skipped.push(`${f.c.company}: ${why}`);
      continue;
    }
    targets.push({
      advertiserId: f.c.advertiserId,
      campaignId: f.campaign._id,
      agentKeyId: f.c.key._id,
      company: f.c.company,
      matchScore: f.matchScore,
      relevantViewers: f.relevantViewers,
    });
  }
  return { band, forecast, valueMinor: value.valueMinor, relevance: value.relevance, priceMinor: price.priceMinor, rule: price.rule, targets, skipped };
}

function forecastDoc(e: Evaluation): Infer<typeof forwardForecast> {
  return {
    expectedPeople: e.forecast.expectedPeople,
    relevance: e.relevance,
    tags: e.forecast.tags,
    confidence: e.forecast.confidence,
    reasoning: `${e.forecast.reasoning}; worth ${usd(e.valueMinor)} at relevance ${e.relevance.toFixed(2)}; ${e.rule}`,
  };
}

/** "forecast 12 people (Startup Demo Day ×1.30)". */
function forecastShort(f: Forecast): string {
  const people = Math.round(f.expectedPeople);
  return `forecast ${people} ${people === 1 ? "person" : "people"}${f.eventName ? ` (${f.eventName} ×${f.eventFactor.toFixed(2)})` : ""}`;
}

async function notify(ctx: MutationCtx, offerId: Id<"forwardOffers">, targets: Target[], event: "forward_offer" | "forward_won" | "forward_auction") {
  for (const t of targets) {
    await ctx.scheduler.runAfter(0, internal.autopilotDelivery.deliver, { offerId, advertiserId: t.advertiserId, event });
  }
}

async function closeOffer(
  ctx: MutationCtx,
  offer: Doc<"forwardOffers">,
  status: "expired" | "withdrawn",
  reason: string,
): Promise<void> {
  await ctx.db.patch(offer._id, { status, closedReason: reason.slice(0, 300), updatedAt: Date.now() });
}

// ---------------------------------------------------------------- the plan

const planResult = v.object({
  skipped: v.union(v.string(), v.null()),
  open: v.number(),
  created: v.number(),
  repriced: v.number(),
  notified: v.number(),
  closed: v.number(),
});

/** One workspace's plan over the next 12 hours of unsold slots (cron every minute, and event hooks). */
export const plan = internalMutation({
  args: { workspaceId: v.id("workspaces"), reason: v.optional(v.string()) },
  returns: planResult,
  handler: async (ctx, args) => {
    const empty = { open: 0, created: 0, repriced: 0, notified: 0, closed: 0 };
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) return { skipped: "no such workspace", ...empty };
    if (!(await autopilotEnabled(ctx, workspace._id))) return { skipped: "paused", ...empty };
    const now = Date.now();
    await upsertSettings(ctx, workspace._id, { lastPlanAt: now });
    const minMatch = momentSettingsOf(workspace).minMatch;
    const companies = await loadCompanies(ctx, workspace._id, now);
    const screens = await ctx.db
      .query("billboards")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .take(MAX_SCREENS);
    const out = { ...empty };
    let notifyBudget = NOTIFY_PER_RUN;

    for (const billboard of screens) {
      const tz = billboard.utcOffsetMinutes;
      const offers = await ctx.db
        .query("forwardOffers")
        .withIndex("by_billboard_and_slotStartAt", (q) => q.eq("billboardId", billboard._id).gte("slotStartAt", now - LIVE_HANDOFF_MS))
        .take(MAX_OFFERS_PER_SCREEN);
      const openBySlot = new Map<Id<"slots">, Doc<"forwardOffers">>();
      const lastBySlot = new Map<Id<"slots">, Doc<"forwardOffers">>();
      for (const o of offers) {
        const slotId = o.slotIds[0];
        if (o.status === "open") openBySlot.set(slotId, o);
        const prev = lastBySlot.get(slotId);
        if (!prev || o._creationTime > prev._creationTime) lastBySlot.set(slotId, o);
      }
      // Offers on slots no longer in the window (or other leftovers) close here too.
      const slots = await ctx.db
        .query("slots")
        .withIndex("by_billboard_and_startAt", (q) => q.eq("billboardId", billboard._id).gte("startAt", now - LIVE_HANDOFF_MS).lte("startAt", now + HORIZON_MS))
        .take(MAX_SLOTS_PER_SCREEN);
      if (billboard.deviceStatus !== "online") {
        for (const o of openBySlot.values()) {
          await closeOffer(ctx, o, "withdrawn", "screen offline");
          out.closed++;
        }
        continue;
      }
      const screen = await loadScreen(ctx, billboard, now);
      const earlyCreated: { startAt: number; priceMinor: number }[] = [];

      for (const slot of slots) {
        const offer = openBySlot.get(slot._id) ?? null;
        const label = slotLabel(slot.startAt, slot.endAt, tz);
        const auction = slot.auctionId ? await ctx.db.get(slot.auctionId) : null;
        if (slot.state !== "available" || auction?.status === "open") {
          if (offer) {
            await closeOffer(ctx, offer, "withdrawn", auction?.status === "open" ? "slot went to auction" : `slot is ${slot.state}`);
            out.closed++;
          }
          continue;
        }
        const msUntil = slot.startAt - now;
        if (offer && (offer.override || (offer.firstLookUntil !== undefined && now < offer.firstLookUntil))) {
          // The owner's sell-now offer stands until it expires; a running first look is left alone.
          if (now >= offer.expiresAt) {
            await closeOffer(ctx, offer, "expired", "unsold when the offer ran out");
            out.closed++;
          } else out.open++;
          continue;
        }
        const band = bandOf(msUntil);
        if (band === "live") {
          if (offer) {
            await closeOffer(ctx, offer, "expired", "handed to the live auction");
            out.closed++;
            await log(ctx, {
              workspaceId: workspace._id,
              billboardId: billboard._id,
              slotId: slot._id,
              offerId: offer._id,
              kind: "handoff",
              text: `${label} on ${billboard.name} still unsold ${leadLabel(msUntil)} out at ${usd(offer.priceMinor)}: handed to the live auction, which sells it when the camera sees people.`,
            });
          }
          continue;
        }
        if (band === "beyond") continue;

        const e = evaluate(screen, slot, companies, minMatch, now);
        const names = e.targets.map((t) => t.company);
        const expiresAt = band === "ahead" ? slot.startAt - LIVE_HANDOFF_MS : slot.startAt - 2 * HOUR;

        if (!offer || offer.band !== band) {
          if (offer) {
            await closeOffer(ctx, offer, "expired", band === "ahead" ? "moved into the 2-hour window" : "re-planned");
            out.closed++;
          }
          const firstLook = firstLookApplies({ targets: e.targets.length, msUntilStart: msUntil });
          const notifyNow = e.targets.length > 0 && notifyBudget > 0;
          const offerId = await ctx.db.insert("forwardOffers", {
            workspaceId: workspace._id,
            billboardId: billboard._id,
            slotIds: [slot._id],
            slotStartAt: slot.startAt,
            priceMinor: e.priceMinor,
            floorMinor: screen.floorMinor,
            valueMinor: e.valueMinor,
            band,
            forecast: forecastDoc(e),
            expiresAt,
            status: "open",
            targets: e.targets,
            notifiedPriceMinor: notifyNow ? e.priceMinor : undefined,
            notifiedAt: notifyNow ? now : undefined,
            firstLookUntil: firstLook && notifyNow ? now + FIRST_LOOK_MS : undefined,
            interest: [],
            updatedAt: now,
          });
          out.created++;
          out.open++;
          if (notifyNow) {
            notifyBudget--;
            out.notified++;
            await notify(ctx, offerId, e.targets, "forward_offer");
            if (firstLook) await ctx.scheduler.runAt(now + FIRST_LOOK_MS, internal.autopilot.decideOffer, { offerId });
          }
          const previous = lastBySlot.get(slot._id);
          const lapsed = previous?.status === "accepted" && previous.acceptedBy ? await ctx.db.get(previous.acceptedBy.holdId) : null;
          const lapsedNote =
            lapsed && (lapsed.status === "expired" || lapsed.status === "released")
              ? ` ${(await ctx.db.get(previous!.acceptedBy!.advertiserId))?.displayName ?? "The buyer"} didn't pay in time, so it's back on sale.`
              : "";
          if (band === "ahead" || lapsedNote) {
            await log(ctx, {
              workspaceId: workspace._id,
              billboardId: billboard._id,
              slotId: slot._id,
              offerId,
              kind: "offer",
              text: `${label} on ${billboard.name} unsold, ${leadLabel(msUntil)} out; ${forecastShort(e.forecast)}; ${
                names.length > 0
                  ? `offered to ${joinNames(names)} at ${usd(e.priceMinor)}${notifyNow ? "" : " (sending shortly)"}${firstLook && notifyNow ? `; ${FIRST_LOOK_MS / 1000} s for both to answer, an auction if more than one wants it` : ""}`
                  : `published at ${usd(e.priceMinor)}; no company fits yet${e.skipped.length ? ` (${e.skipped.slice(0, 2).join("; ")})` : ""}`
              }.${lapsedNote}`,
            });
          } else {
            earlyCreated.push({ startAt: slot.startAt, priceMinor: e.priceMinor });
            if (earlyCreated.length <= LOG_EACH_UP_TO) {
              await log(ctx, {
                workspaceId: workspace._id,
                billboardId: billboard._id,
                slotId: slot._id,
                offerId,
                kind: "offer",
                text: `${label} on ${billboard.name}, ${leadLabel(msUntil)} out: early-booking price ${usd(e.priceMinor)} (worth ${usd(e.valueMinor)}); ${forecastShort(e.forecast)}${
                  names.length > 0 ? `; offered to ${joinNames(names)}` : "; no company fits yet"
                }.`,
              });
            }
          }
          continue;
        }

        // An open offer in the same band: re-price, and tell companies when it moved enough or a new one fits.
        out.open++;
        const known = new Set(offer.targets.map((t) => t.advertiserId));
        const fresh = e.targets.filter((t) => !known.has(t.advertiserId));
        const moved = shouldRenotify(offer.notifiedPriceMinor, e.priceMinor);
        const changed = e.priceMinor !== offer.priceMinor || fresh.length > 0 || e.targets.length !== offer.targets.length;
        if (!changed && !(moved && e.targets.length > 0)) continue;
        const sendAll = moved && e.targets.length > 0 && notifyBudget > 0;
        const sendFresh = !sendAll && fresh.length > 0 && notifyBudget > 0;
        await ctx.db.patch(offer._id, {
          priceMinor: e.priceMinor,
          valueMinor: e.valueMinor,
          forecast: forecastDoc(e),
          targets: e.targets,
          expiresAt,
          updatedAt: now,
          ...(sendAll || sendFresh ? { notifiedPriceMinor: sendAll ? e.priceMinor : (offer.notifiedPriceMinor ?? e.priceMinor), notifiedAt: now } : {}),
        });
        if (e.priceMinor !== offer.priceMinor) out.repriced++;
        if (sendAll || sendFresh) {
          notifyBudget--;
          out.notified++;
          await notify(ctx, offer._id, sendAll ? e.targets : fresh, "forward_offer");
          if (offer.notifiedPriceMinor !== undefined) {
            const direction = e.priceMinor < offer.notifiedPriceMinor ? "down" : "up";
            await log(ctx, {
              workspaceId: workspace._id,
              billboardId: billboard._id,
              slotId: slot._id,
              offerId: offer._id,
              kind: "reprice",
              text: sendAll
                ? `${label} on ${billboard.name} still unsold, ${leadLabel(msUntil)} out: price ${direction} from ${usd(offer.notifiedPriceMinor)} to ${usd(e.priceMinor)} (${
                    direction === "down" ? `decaying toward the ${usd(screen.floorMinor)} floor` : "forecast or demand rose"
                  }); ${forecastShort(e.forecast)}; re-offered to ${joinNames(names)}.`
                : `${label} on ${billboard.name}: ${joinNames(fresh.map((t) => t.company))} now ${fresh.length === 1 ? "fits" : "fit"}; offered at ${usd(e.priceMinor)}.`,
            });
          }
        }
      }
      if (earlyCreated.length > LOG_EACH_UP_TO) {
        const rest = earlyCreated.slice(LOG_EACH_UP_TO);
        const prices = rest.map((x) => x.priceMinor);
        await log(ctx, {
          workspaceId: workspace._id,
          billboardId: billboard._id,
          kind: "plan",
          text: `Published early-booking prices for ${rest.length} more slots on ${billboard.name}, ${clockLabel(rest[0].startAt, tz)} to ${clockLabel(rest[rest.length - 1].startAt, tz)}: ${usd(Math.min(...prices))}–${usd(Math.max(...prices))}, lower where fewer people are forecast.`,
        });
      }
    }
    return { skipped: null, ...out };
  },
});

/** Cron (every minute): plan every workspace whose autopilot is on. */
export const planAll = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const workspaces = await ctx.db.query("workspaces").take(100);
    let n = 0;
    for (const ws of workspaces) {
      if (!(await autopilotEnabled(ctx, ws._id))) continue;
      const screen = await ctx.db
        .query("billboards")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id))
        .first();
      if (!screen) continue;
      await ctx.scheduler.runAfter(0, internal.autopilot.plan, { workspaceId: ws._id, reason: "every minute" });
      n++;
    }
    return n;
  },
});

// ---------------------------------------------------------------- accepting

const acceptResult = v.union(
  v.object({
    status: v.literal("held"),
    offerId: v.id("forwardOffers"),
    holdId: v.id("holds"),
    amountMinor: v.number(),
    expiresAt: v.number(),
    purchaseUrl: v.string(),
  }),
  v.object({
    status: v.literal("pending"),
    offerId: v.id("forwardOffers"),
    /** When the first look ends: then one company gets the hold (`forward_won`) or an auction opens (`forward_auction`). */
    decideAt: v.number(),
    interested: v.number(),
  }),
);
type AcceptResult = Infer<typeof acceptResult>;

/** Hold the offer's slot for one company at the offer price (its quote), and mark the offer accepted. */
async function holdFor(
  ctx: MutationCtx,
  offer: Doc<"forwardOffers">,
  who: { advertiserId: Id<"advertisers">; campaignId: Id<"campaigns">; agentKeyId: Id<"agentKeys">; quoteId: Id<"quotes"> },
): Promise<Doc<"holds">> {
  const quote = (await ctx.db.get(who.quoteId))!;
  const company = (await ctx.db.get(who.advertiserId))?.displayName ?? "Company";
  const key = await ctx.db.get(who.agentKeyId);
  const hold = await takeHold(ctx, quote, `forward:${offer._id}:${who.advertiserId}`, `agent:${company}/${key?.name ?? "agent"}`, {
    agentKeyId: who.agentKeyId,
  });
  const now = Date.now();
  await ctx.db.patch(offer._id, {
    status: "accepted",
    acceptedBy: { advertiserId: who.advertiserId, campaignId: who.campaignId, holdId: hold._id, at: now },
    firstLookUntil: undefined,
    updatedAt: now,
  });
  const billboard = await ctx.db.get(offer.billboardId);
  const tz = billboard?.utcOffsetMinutes ?? 0;
  await log(ctx, {
    workspaceId: offer.workspaceId,
    billboardId: offer.billboardId,
    slotId: offer.slotIds[0],
    offerId: offer._id,
    kind: "accepted",
    text: `${company} booked ${slotLabel(offer.slotStartAt, offer.slotStartAt + 15 * MINUTE, tz)} on ${billboard?.name ?? "a screen"} at ${usd(offer.priceMinor)} (${Math.round(
      offer.forecast.expectedPeople,
    )} people forecast); its agent pays over x402 within ${Math.round((hold.expiresAt - now) / MINUTE)} min.`,
  });
  return hold;
}

/**
 * A company takes a forward offer at its price. Verifies the offer is open,
 * the autopilot is on, the slot is free, the campaign's creative is ready at
 * this host and the company's limits (max per spot, daily budget, key budget
 * cap) hold. Outside a first look it takes the hold now; during one it
 * registers the yes and the decision comes when the first look ends.
 */
async function acceptCore(
  ctx: MutationCtx,
  offerId: Id<"forwardOffers">,
  advertiserId: Id<"advertisers">,
  campaignId: Id<"campaigns">,
): Promise<AcceptResult> {
  const now = Date.now();
  const offer = await ctx.db.get(offerId);
  if (!offer) fail("NOT_FOUND", "Offer not found");
  if (offer.status !== "open" || now >= offer.expiresAt) fail("OFFER_CLOSED", `This offer is ${offer.status === "open" ? "expired" : offer.status}`);
  if (!offer.override && !(await autopilotEnabled(ctx, offer.workspaceId))) fail("AUTOPILOT_PAUSED", "The host paused its autopilot");
  const campaign = await ctx.db.get(campaignId);
  if (!campaign || campaign.advertiserId !== advertiserId) fail("NOT_FOUND", "Campaign not found for this company");
  if (campaign.status !== "active") fail("CAMPAIGN_INACTIVE", "The campaign is not active");
  if (!(await creativeReady(ctx, campaign, offer.workspaceId))) fail("CREATIVE_NOT_READY", "The host hasn't approved this campaign's ad yet");
  for (const slotId of offer.slotIds) {
    const slot = await ctx.db.get(slotId);
    const auction = slot?.auctionId ? await ctx.db.get(slot.auctionId) : null;
    if (!slot || slot.state !== "available" || slot.startAt <= now || auction?.status === "open") {
      await closeOffer(ctx, offer, "withdrawn", "slot no longer available");
      fail("SLOT_UNAVAILABLE", "The slot is no longer available");
    }
  }
  const key = await sellingKey(ctx, advertiserId, campaignId, now);
  if (!key) fail("NO_AGENT_KEY", "No active agent key with the hold and pay scopes and standing instructions for this campaign");
  const why = replyAllowed(key.standing as Standing, offer.priceMinor, await spentTodayForAdvertiserMinor(ctx, advertiserId, now));
  if (why) fail("STANDING_INSTRUCTIONS", `Refused: ${why}`);
  await assertWithinBudget(ctx, key, offer.priceMinor);

  const interest = offer.interest ?? [];
  const mine = interest.find((i) => i.advertiserId === advertiserId);
  const inFirstLook = offer.firstLookUntil !== undefined && now < offer.firstLookUntil;
  if (mine && inFirstLook) {
    return { status: "pending", offerId, decideAt: offer.firstLookUntil!, interested: new Set(interest.map((i) => i.advertiserId)).size };
  }

  const company = (await ctx.db.get(advertiserId))?.displayName ?? "Company";
  const quoteId = await ctx.db.insert("quotes", {
    workspaceId: offer.workspaceId,
    campaignId,
    billboardId: offer.billboardId,
    slotIds: offer.slotIds,
    amountMinor: offer.priceMinor,
    currency: "USD",
    expiresAt: now + QUOTE_TTL_MS,
    pricingBasis: [`Forward offer from the host's autopilot (${offer.band === "ahead" ? "forecast price" : "early-booking price"})`, offer.forecast.reasoning],
    confidence: offer.forecast.confidence >= 0.7 ? "high" : offer.forecast.confidence >= 0.5 ? "medium" : "low",
    policyVersion: PRICING_POLICY_VERSION,
    status: "open",
    traceId: `forward:${offerId}`,
    agentKeyId: key._id,
    screenAmountMinor: offer.priceMinor,
  });
  await ctx.scheduler.runAt(now + QUOTE_TTL_MS, internal.quotes.expire, { quoteId });
  const entry = { advertiserId, campaignId, agentKeyId: key._id, quoteId, at: now };

  if (inFirstLook) {
    const next = [...interest, entry];
    await ctx.db.patch(offerId, { interest: next, updatedAt: now });
    const billboard = await ctx.db.get(offer.billboardId);
    await log(ctx, {
      workspaceId: offer.workspaceId,
      billboardId: offer.billboardId,
      slotId: offer.slotIds[0],
      offerId,
      kind: "interest",
      text: `${company} wants ${slotLabel(offer.slotStartAt, offer.slotStartAt + 15 * MINUTE, billboard?.utcOffsetMinutes ?? 0)} on ${billboard?.name ?? "a screen"} at ${usd(offer.priceMinor)}; deciding when the first look ends.`,
    });
    return { status: "pending", offerId, decideAt: offer.firstLookUntil!, interested: new Set(next.map((i) => i.advertiserId)).size };
  }

  const hold = await holdFor(ctx, offer, entry);
  return { status: "held", offerId, holdId: hold._id, amountMinor: hold.amountMinor, expiresAt: hold.expiresAt, purchaseUrl: purchaseUrlFor(offer.workspaceId, hold._id) };
}

/**
 * Take a forward offer for a company (its server-run agent calls this).
 * Returns the hold and its x402 purchase URL, or "pending" during a first look.
 */
export const acceptForwardOffer = internalMutation({
  args: { offerId: v.id("forwardOffers"), advertiserId: v.id("advertisers"), campaignId: v.id("campaigns") },
  returns: acceptResult,
  handler: async (ctx, args) => await acceptCore(ctx, args.offerId, args.advertiserId, args.campaignId),
});

/** POST /api/autopilot/offers/{id}/accept with an agent key (external agents). */
export const acceptByKey = internalMutation({
  args: { token: v.string(), offerId: v.string(), campaignId: v.optional(v.string()) },
  returns: acceptResult,
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "hold");
    const offerId = ctx.db.normalizeId("forwardOffers", args.offerId);
    if (!offerId) fail("NOT_FOUND", "Offer not found");
    const offer = await ctx.db.get(offerId);
    if (!offer) fail("NOT_FOUND", "Offer not found");
    const target = offer.targets.find((t) => t.advertiserId === agent.key.advertiserId);
    const raw = args.campaignId ?? target?.campaignId ?? agent.key.campaignIds?.[0];
    const campaignId = raw ? ctx.db.normalizeId("campaigns", raw) : null;
    if (!campaignId) fail("INVALID_INPUT", "Send campaignId");
    if (agent.key.campaignIds && !agent.key.campaignIds.includes(campaignId)) fail("FORBIDDEN", "This key can't act for that campaign");
    return await acceptCore(ctx, offerId, agent.key.advertiserId, campaignId);
  },
});

/**
 * The first look is over: nobody said yes (the offer stays open, first come
 * first served), one company (it gets the hold), or two or more (contention:
 * a scheduled ascending auction opens through auctions.openIfHot).
 */
export const decideOffer = internalMutation({
  args: { offerId: v.id("forwardOffers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const offer = await ctx.db.get(args.offerId);
    if (!offer || offer.status !== "open" || offer.firstLookUntil === undefined) return null;
    const now = Date.now();
    if (now < offer.firstLookUntil) {
      await ctx.scheduler.runAt(offer.firstLookUntil, internal.autopilot.decideOffer, args);
      return null;
    }
    // Earliest yes per company, with its quote still open.
    const seen = new Set<string>();
    const interest = [];
    for (const i of [...(offer.interest ?? [])].sort((a, b) => a.at - b.at)) {
      if (seen.has(i.advertiserId)) continue;
      const quote = await ctx.db.get(i.quoteId);
      if (quote?.status !== "open") continue;
      seen.add(i.advertiserId);
      interest.push(i);
    }
    await ctx.db.patch(offer._id, { firstLookUntil: undefined, updatedAt: now });
    const decision = decideInterest(interest.length);
    if (decision === "keep_open") return null;
    const slot = await ctx.db.get(offer.slotIds[0]);
    const billboard = await ctx.db.get(offer.billboardId);
    const label = slotLabel(offer.slotStartAt, offer.slotStartAt + 15 * MINUTE, billboard?.utcOffsetMinutes ?? 0);
    const canAuction = slot !== null && slot.startAt - now >= AUCTION_LEAD_MS;
    if (decision === "auction" && canAuction) {
      const names: string[] = [];
      for (const i of interest) names.push((await ctx.db.get(i.advertiserId))?.displayName ?? "A company");
      await closeOffer(ctx, offer, "withdrawn", `${interest.length} companies want it: scheduled auction`);
      await ctx.scheduler.runAfter(0, internal.auctions.openIfHot, { slotId: offer.slotIds[0] });
      await ctx.scheduler.runAfter(2_000, internal.autopilot.afterAuction, { offerId: offer._id });
      await log(ctx, {
        workspaceId: offer.workspaceId,
        billboardId: offer.billboardId,
        slotId: offer.slotIds[0],
        offerId: offer._id,
        kind: "auction",
        text: `${joinNames(names)} all want ${label} on ${billboard?.name ?? "a screen"} at ${usd(offer.priceMinor)}: opening a 2-minute ascending auction instead of picking one.`,
      });
      return null;
    }
    await awardFirst(ctx, (await ctx.db.get(offer._id))!, interest);
    return null;
  },
});

/** The earliest yes still able to buy gets the hold; it hears `forward_won` with the purchase URL. */
async function awardFirst(
  ctx: MutationCtx,
  offer: Doc<"forwardOffers">,
  interest: NonNullable<Doc<"forwardOffers">["interest"]>,
): Promise<void> {
  for (const i of interest) {
    try {
      await holdFor(ctx, offer, i);
    } catch (error) {
      if (error instanceof ConvexError && (error.data as { code?: string }).code === "SLOT_UNAVAILABLE") {
        await closeOffer(ctx, offer, "withdrawn", "slot no longer available");
        return;
      }
      continue;
    }
    await notify(ctx, offer._id, [{ advertiserId: i.advertiserId, campaignId: i.campaignId, agentKeyId: i.agentKeyId, company: "", matchScore: 0, relevantViewers: 0 }], "forward_won");
    return;
  }
}

/** After contention: tell the interested companies where the auction is (or, if it didn't open, award the earliest yes). */
export const afterAuction = internalMutation({
  args: { offerId: v.id("forwardOffers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const offer = await ctx.db.get(args.offerId);
    if (!offer) return null;
    const slot = await ctx.db.get(offer.slotIds[0]);
    const auction = slot?.auctionId ? await ctx.db.get(slot.auctionId) : null;
    const interest = [...(offer.interest ?? [])].sort((a, b) => a.at - b.at);
    if (auction?.status === "open") {
      await ctx.db.patch(offer._id, { auctionId: auction._id, updatedAt: Date.now() });
      const seen = new Set<string>();
      const targets: Target[] = [];
      for (const i of interest) {
        if (seen.has(i.advertiserId)) continue;
        seen.add(i.advertiserId);
        targets.push({ advertiserId: i.advertiserId, campaignId: i.campaignId, agentKeyId: i.agentKeyId, company: "", matchScore: 0, relevantViewers: 0 });
      }
      await notify(ctx, offer._id, targets, "forward_auction");
      await log(ctx, {
        workspaceId: offer.workspaceId,
        billboardId: offer.billboardId,
        slotId: offer.slotIds[0],
        offerId: offer._id,
        kind: "auction",
        text: `Auction open: reserve ${usd(auction.reserveMinor)}, closes in about ${Math.max(1, Math.round((auction.endsAt - Date.now()) / MINUTE))} min; the interested agents were told where to bid.`,
      });
      return null;
    }
    // The auction didn't open (too close to air time by now, or the slot changed): first yes wins.
    await ctx.db.patch(offer._id, { status: "open", closedReason: undefined, updatedAt: Date.now() });
    await awardFirst(ctx, (await ctx.db.get(offer._id))!, interest);
    return null;
  },
});

// ---------------------------------------------------------------- owner controls (emergency)

/** Owner: pause or resume the autopilot. Pausing withdraws every open offer at once. */
export const setEnabled = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    await requireWorkspaceMember(ctx, me.workspaceId, "owner");
    const now = Date.now();
    const current = await autopilotEnabled(ctx, me.workspaceId);
    if (current === args.enabled) return null;
    await upsertSettings(ctx, me.workspaceId, { enabled: args.enabled, changedBy: me.actor, changedAt: now });
    if (!args.enabled) {
      const open = await ctx.db
        .query("forwardOffers")
        .withIndex("by_workspace_and_status", (q) => q.eq("workspaceId", me.workspaceId).eq("status", "open"))
        .take(1000);
      for (const o of open) await closeOffer(ctx, o, "withdrawn", "autopilot paused by the owner");
      await log(ctx, { workspaceId: me.workspaceId, kind: "paused", text: `Paused by ${me.email}: ${open.length} open offer${open.length === 1 ? "" : "s"} withdrawn; nothing is sold ahead until it's back on. The live auction keeps selling the current spot.` });
    } else {
      await log(ctx, { workspaceId: me.workspaceId, kind: "resumed", text: `Back on (${me.email}): planning the next 12 hours now.` });
      await ctx.scheduler.runAfter(0, internal.autopilot.plan, { workspaceId: me.workspaceId, reason: "resumed" });
    }
    return null;
  },
});

/**
 * Owner's emergency override: offer this slot right now to every company that
 * fits, at the fully decayed price (never under the floor), first come first
 * served. Works while the autopilot is paused.
 */
export const sellNow = mutation({
  args: { slotId: v.id("slots") },
  returns: v.object({ offerId: v.id("forwardOffers"), priceMinor: v.number(), companies: v.number() }),
  handler: async (ctx, args) => {
    const slot = await ctx.db.get(args.slotId);
    if (!slot) fail("NOT_FOUND", "Slot not found");
    const billboard = await ctx.db.get(slot.billboardId);
    if (!billboard?.workspaceId) fail("NOT_FOUND", "Screen not found");
    const owner = await requireWorkspaceMember(ctx, billboard.workspaceId, "owner");
    const now = Date.now();
    if (slot.state !== "available") fail("SLOT_UNAVAILABLE", `This slot is ${slot.state}`);
    if (slot.startAt <= now + MINUTE) fail("SLOT_TOO_SOON", "This slot has started (the live auction sells the current spot)");
    if (slot.startAt > now + HORIZON_MS) fail("SLOT_TOO_FAR", "Only the next 12 hours can be sold now");
    const auction = slot.auctionId ? await ctx.db.get(slot.auctionId) : null;
    if (auction?.status === "open") fail("AUCTION_OPEN", "This slot is in an auction");
    const workspace = (await ctx.db.get(billboard.workspaceId))!;
    const existing = await ctx.db
      .query("forwardOffers")
      .withIndex("by_billboard_and_status_and_slotStartAt", (q) => q.eq("billboardId", billboard._id).eq("status", "open").eq("slotStartAt", slot.startAt))
      .take(5);
    for (const o of existing) await closeOffer(ctx, o, "withdrawn", "replaced by the owner's sell-now");
    const screen = await loadScreen(ctx, billboard, now);
    const companies = await loadCompanies(ctx, workspace._id, now);
    // Priced as if the slot were at the live hand-off: fully decayed toward the floor.
    const e = evaluate(screen, slot, companies, momentSettingsOf(workspace).minMatch, now, {
      band: "ahead",
      priceMsUntil: Math.min(slot.startAt - now, LIVE_HANDOFF_MS),
    });
    const offerId = await ctx.db.insert("forwardOffers", {
      workspaceId: workspace._id,
      billboardId: billboard._id,
      slotIds: [slot._id],
      slotStartAt: slot.startAt,
      priceMinor: e.priceMinor,
      floorMinor: screen.floorMinor,
      valueMinor: e.valueMinor,
      band: "ahead",
      forecast: forecastDoc(e),
      expiresAt: slot.startAt - MINUTE,
      status: "open",
      targets: e.targets,
      notifiedPriceMinor: e.targets.length > 0 ? e.priceMinor : undefined,
      notifiedAt: e.targets.length > 0 ? now : undefined,
      interest: [],
      override: true,
      updatedAt: now,
    });
    await notify(ctx, offerId, e.targets, "forward_offer");
    await log(ctx, {
      workspaceId: workspace._id,
      billboardId: billboard._id,
      slotId: slot._id,
      offerId,
      kind: "sell_now",
      text: `${owner.email} asked to sell ${slotLabel(slot.startAt, slot.endAt, billboard.utcOffsetMinutes)} on ${billboard.name} now: ${
        e.targets.length > 0 ? `offered to ${joinNames(e.targets.map((t) => t.company))}` : "no company fits, published"
      } at ${usd(e.priceMinor)} (floor ${usd(screen.floorMinor)}).`,
    });
    return { offerId, priceMinor: e.priceMinor, companies: e.targets.length };
  },
});

// ---------------------------------------------------------------- views

const logEntry = v.object({
  _id: v.id("autopilotLog"),
  at: v.number(),
  kind: autopilotLogKind,
  text: v.string(),
  billboardId: v.union(v.id("billboards"), v.null()),
});

async function latestLog(ctx: QueryCtx, workspaceId: Id<"workspaces">, limit: number) {
  const rows = await ctx.db
    .query("autopilotLog")
    .withIndex("by_workspace_and_at", (q) => q.eq("workspaceId", workspaceId))
    .order("desc")
    .take(limit);
  return rows.map((r) => ({ _id: r._id, at: r.at, kind: r.kind, text: r.text, billboardId: r.billboardId ?? null }));
}

/** Host: the autopilot's reasoning, newest first (live). */
export const recentLog = query({
  args: { workspaceId: v.optional(v.id("workspaces")), limit: v.optional(v.number()) },
  returns: v.array(logEntry),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? LOG_SHOWN)));
    return await latestLog(ctx, me.workspaceId, limit);
  },
});

/** Host console's Autopilot panel: on/off, what it's doing, booked ahead, unsold hours at risk, latest reasoning. */
export const status = query({
  args: { workspaceId: v.optional(v.id("workspaces")), atMinute: v.number() },
  returns: v.object({
    enabled: v.boolean(),
    canChange: v.boolean(),
    changedBy: v.union(v.string(), v.null()),
    lastPlanAt: v.union(v.number(), v.null()),
    doing: v.string(),
    openOffers: v.object({ ahead: v.number(), early: v.number(), firstLooks: v.number() }),
    bookedAhead: v.object({ slots: v.number(), amountMinor: v.number() }),
    atRisk: v.object({ slots: v.number(), hours: v.number() }),
    companies: v.number(),
    log: v.array(logEntry),
  }),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    if (!Number.isFinite(args.atMinute)) fail("INVALID_INPUT", "atMinute must be a timestamp");
    const now = args.atMinute;
    const settings = await settingsOf(ctx, me.workspaceId);
    const enabled = settings?.enabled ?? true;
    const open = await ctx.db
      .query("forwardOffers")
      .withIndex("by_workspace_and_status", (q) => q.eq("workspaceId", me.workspaceId).eq("status", "open"))
      .take(1000);
    const live = open.filter((o) => o.expiresAt > now);
    const ahead = live.filter((o) => o.band === "ahead").length;
    const early = live.filter((o) => o.band === "early").length;
    const firstLooks = live.filter((o) => o.firstLookUntil !== undefined && o.firstLookUntil > now).length;
    const offered = new Set<string>();
    for (const o of live) for (const t of o.targets) offered.add(t.advertiserId);

    const screens = await ctx.db
      .query("billboards")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .take(MAX_SCREENS);
    let bookedSlots = 0;
    let bookedMinor = 0;
    let riskSlots = 0;
    for (const s of screens) {
      const slots = await ctx.db
        .query("slots")
        .withIndex("by_billboard_and_startAt", (q) => q.eq("billboardId", s._id).gt("startAt", now).lte("startAt", now + HORIZON_MS))
        .take(MAX_SLOTS_PER_SCREEN);
      for (const slot of slots) {
        if (slot.state === "available") {
          if (slot.startAt - now < 2 * HOUR && s.deviceStatus === "online") riskSlots++;
          continue;
        }
        if (slot.state === "held" || slot.state === "booked" || slot.state === "scheduled") {
          bookedSlots++;
          const deal = slot.bookingId ? await ctx.db.get(slot.bookingId) : slot.holdId ? await ctx.db.get(slot.holdId) : null;
          if (deal) bookedMinor += Math.round(deal.amountMinor / Math.max(1, deal.slotIds.length));
        }
      }
    }
    const doing = !enabled
      ? `Paused${settings?.changedBy ? ` by ${settings.changedBy.replace(/^operator:/, "")}` : ""}: not selling ahead. The live auction still sells the current spot.`
      : live.length === 0
        ? "Watching the next 12 hours; every upcoming slot is sold or handed to the live auction."
        : `Selling ${ahead} slot${ahead === 1 ? "" : "s"} in the next 2 hours at forecast prices and ${early} later at early-booking prices${
            offered.size > 0 ? `, offered to ${offered.size} compan${offered.size === 1 ? "y" : "ies"}` : "; no company agent fits yet"
          }${firstLooks > 0 ? `; waiting on ${firstLooks} first look${firstLooks === 1 ? "" : "s"}` : ""}.`;
    return {
      enabled,
      canChange: me.role === "owner",
      changedBy: settings?.changedBy ?? null,
      lastPlanAt: settings?.lastPlanAt ?? null,
      doing,
      openOffers: { ahead, early, firstLooks },
      bookedAhead: { slots: bookedSlots, amountMinor: bookedMinor },
      atRisk: { slots: riskSlots, hours: riskSlots / 4 },
      companies: offered.size,
      log: await latestLog(ctx, me.workspaceId, 8),
    };
  },
});

const outlookSlot = v.object({
  slotId: v.id("slots"),
  startAt: v.number(),
  endAt: v.number(),
  state: slotState,
  /** Past slots: what happened. */
  outcome: v.union(v.literal("played"), v.literal("failed"), v.literal("unsold"), v.literal("sold"), v.null()),
  priceMinor: v.union(v.number(), v.null()),
  expectedPeople: v.union(v.number(), v.null()),
  confidence: v.union(v.number(), v.null()),
  band: v.union(forwardBand, v.null()),
  offerStatus: v.union(forwardOfferStatus, v.null()),
  offeredTo: v.number(),
  firstLookUntil: v.union(v.number(), v.null()),
  inAuction: v.boolean(),
  /** Who booked it: hosts see the company; everyone else sees null. */
  bookedBy: v.union(v.string(), v.null()),
  /** The autopilot's reasoning for this slot (hosts only). */
  reasoning: v.union(v.string(), v.null()),
});

/**
 * One screen's slots in [from, to] (at most 26 hours) with the autopilot's
 * view: past outcome, the live offer's price and forecast (or the forecast
 * the plan would use), and who booked it (hosts only). Public: the booking
 * page shows it to every signed-in customer.
 */
export const outlook = query({
  args: { billboardId: v.id("billboards"), from: v.number(), to: v.number(), atMinute: v.number() },
  returns: v.object({ billboardName: v.string(), floorMinor: v.number(), isHost: v.boolean(), slots: v.array(outlookSlot) }),
  handler: async (ctx, args) => {
    if (![args.from, args.to, args.atMinute].every(Number.isFinite) || args.to < args.from || args.to - args.from > 26 * HOUR) {
      fail("INVALID_INPUT", "Need finite from <= to, at most 26 hours apart");
    }
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) fail("NOT_FOUND", "Screen not found");
    const now = args.atMinute;
    const userId = await getAuthUserId(ctx);
    const member =
      userId && billboard.workspaceId
        ? await ctx.db
            .query("workspaceMembers")
            .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", billboard.workspaceId!).eq("userId", userId))
            .unique()
        : null;
    const isHost = member !== null;
    const slots = await ctx.db
      .query("slots")
      .withIndex("by_billboard_and_startAt", (q) => q.eq("billboardId", billboard._id).gte("startAt", args.from).lte("startAt", args.to))
      .take(120);
    const offers = await ctx.db
      .query("forwardOffers")
      .withIndex("by_billboard_and_slotStartAt", (q) => q.eq("billboardId", billboard._id).gte("slotStartAt", args.from).lte("slotStartAt", args.to))
      .take(MAX_OFFERS_PER_SCREEN);
    const offerFor = new Map<Id<"slots">, Doc<"forwardOffers">>();
    for (const o of offers) {
      const prev = offerFor.get(o.slotIds[0]);
      // Prefer the open offer, else the newest.
      if (!prev || (o.status === "open" && prev.status !== "open") || (prev.status !== "open" && o._creationTime > prev._creationTime)) offerFor.set(o.slotIds[0], o);
    }
    let screen: Screen | null = null;
    const floorMinor =
      Number.isSafeInteger(billboard.reserveFloorMinor) && billboard.reserveFloorMinor > 0 ? billboard.reserveFloorMinor : DEFAULT_LIVE_MINIMUM_MINOR;
    const out = [];
    for (const slot of slots) {
      const past = slot.endAt <= now;
      const offer = offerFor.get(slot._id) ?? null;
      const auction = slot.auctionId ? await ctx.db.get(slot.auctionId) : null;
      let bookedBy: string | null = null;
      if (isHost && slot.bookingId) {
        const booking = await ctx.db.get(slot.bookingId);
        const campaign = booking ? await ctx.db.get(booking.campaignId) : null;
        bookedBy = campaign ? ((await ctx.db.get(campaign.advertiserId))?.displayName ?? null) : null;
      } else if (isHost && slot.holdId) {
        const hold = await ctx.db.get(slot.holdId);
        const quote = hold ? await ctx.db.get(hold.quoteId) : null;
        const campaign = quote ? await ctx.db.get(quote.campaignId) : null;
        bookedBy = campaign ? ((await ctx.db.get(campaign.advertiserId))?.displayName ?? null) : null;
      }
      let expectedPeople: number | null = offer?.forecast.expectedPeople ?? null;
      let confidence: number | null = offer?.forecast.confidence ?? null;
      let priceMinor: number | null = offer && (offer.status === "open" || offer.status === "accepted") ? offer.priceMinor : null;
      // No offer yet for an upcoming unsold slot: show the forecast the plan would use.
      if (!past && !offer && slot.state === "available" && slot.startAt > now && slot.startAt <= now + HORIZON_MS) {
        screen ??= await loadScreen(ctx, billboard, now);
        const f = forecastSlot({
          slotStartAt: slot.startAt,
          slotEndAt: slot.endAt,
          now,
          utcOffsetMinutes: billboard.utcOffsetMinutes,
          normalTrafficPer15: billboard.audienceBaselinePerBucket,
          camera: screen.camera,
          events: screen.events,
          screenTags: billboard.audienceTags,
        });
        expectedPeople = f.expectedPeople;
        confidence = f.confidence;
        const value = forwardValue({ expectedPeople: f.expectedPeople, slotMs: slot.endAt - slot.startAt, cpmRefMinor: screen.cpmRefMinor, bestMatch: 0, floorMinor });
        const band = bandOf(slot.startAt - now);
        if (band === "ahead" || band === "early") {
          priceMinor = forwardPrice({ band, valueMinor: value.valueMinor, floorMinor, msUntilStart: slot.startAt - now, interested: 0 }).priceMinor;
        }
      }
      out.push({
        slotId: slot._id,
        startAt: slot.startAt,
        endAt: slot.endAt,
        state: slot.state,
        outcome: !past
          ? null
          : slot.state === "played"
            ? ("played" as const)
            : slot.state === "failed_delivery"
              ? ("failed" as const)
              : slot.state === "available" || slot.state === "held"
                ? ("unsold" as const)
                : ("sold" as const),
        priceMinor,
        expectedPeople,
        confidence,
        band: offer?.band ?? null,
        offerStatus: offer?.status ?? null,
        offeredTo: offer?.status === "open" ? offer.targets.length : 0,
        firstLookUntil: offer?.status === "open" && offer.firstLookUntil !== undefined ? offer.firstLookUntil : null,
        inAuction: auction?.status === "open",
        bookedBy,
        reasoning: isHost && offer ? offer.forecast.reasoning : null,
      });
    }
    return { billboardName: billboard.name, floorMinor, isHost, slots: out };
  },
});

// ---------------------------------------------------------------- for company agents (internal)

const offerForCompany = v.object({
  offerId: v.id("forwardOffers"),
  workspaceId: v.id("workspaces"),
  billboardId: v.id("billboards"),
  billboardName: v.string(),
  slotIds: v.array(v.id("slots")),
  startAt: v.number(),
  endAt: v.number(),
  band: forwardBand,
  priceMinor: v.number(),
  floorMinor: v.number(),
  valueMinor: v.number(),
  forecast: forwardForecast,
  campaignId: v.id("campaigns"),
  matchScore: v.number(),
  relevantViewers: v.number(),
  expiresAt: v.number(),
  firstLookUntil: v.union(v.number(), v.null()),
});

/** Open forward offers that went to this company (its agent's planning input), soonest first. */
export const openOffersForCompany = internalQuery({
  args: { advertiserId: v.id("advertisers"), now: v.number(), limit: v.optional(v.number()) },
  returns: v.array(offerForCompany),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 50)));
    // Offers are few per workspace; scan the open ones of every workspace this company's campaigns are approved at.
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", args.advertiserId))
      .take(50);
    const workspaces = new Set<Id<"workspaces">>();
    for (const c of campaigns) {
      const rows = await ctx.db
        .query("creativeApprovals")
        .withIndex("by_campaign", (q) => q.eq("campaignId", c._id))
        .take(20);
      for (const r of rows) workspaces.add(r.workspaceId);
    }
    const out: Infer<typeof offerForCompany>[] = [];
    for (const workspaceId of workspaces) {
      const open = await ctx.db
        .query("forwardOffers")
        .withIndex("by_workspace_and_status", (q) => q.eq("workspaceId", workspaceId).eq("status", "open"))
        .take(500);
      for (const o of open) {
        const t = o.targets.find((x) => x.advertiserId === args.advertiserId);
        if (!t || o.expiresAt <= args.now) continue;
        const slot = await ctx.db.get(o.slotIds[0]);
        out.push({
          offerId: o._id,
          workspaceId: o.workspaceId,
          billboardId: o.billboardId,
          billboardName: (await ctx.db.get(o.billboardId))?.name ?? "Screen",
          slotIds: o.slotIds,
          startAt: o.slotStartAt,
          endAt: slot?.endAt ?? o.slotStartAt + 15 * MINUTE,
          band: o.band,
          priceMinor: o.priceMinor,
          floorMinor: o.floorMinor,
          valueMinor: o.valueMinor,
          forecast: o.forecast,
          campaignId: t.campaignId,
          matchScore: t.matchScore,
          relevantViewers: t.relevantViewers,
          expiresAt: o.expiresAt,
          firstLookUntil: o.firstLookUntil ?? null,
        });
      }
    }
    out.sort((a, b) => a.startAt - b.startAt);
    return out.slice(0, limit);
  },
});
