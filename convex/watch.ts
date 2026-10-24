import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { computeScreenPrice } from "./lib/screenPrice";
import { matchScore } from "./lib/match";
import { keyStatus } from "./lib/agentKeys";
import {
  LAST_MINUTE_WINDOW_MS,
  MAX_SLOTS_PER_ALERT,
  ruleFitsSlot,
  triggersFor,
  type WatchTrigger,
} from "./lib/watch";

/**
 * Watch-rule matcher (ADR 0004). Runs on events (slots generated, hold
 * released/expired, auction opened) and on a 5-minute sweep. Bounded per run;
 * dedupes per (rule, slot, trigger) via `watchMatches`; groups new matches
 * into one alert per (rule, trigger, screen[, auction]).
 */

const MAX_RULES = 100;
/** The sweep fans out one matcher run per screen (each its own transaction). */
const MAX_SWEEP_BILLBOARDS = 50;
const MAX_SLOTS_PER_BILLBOARD = 48;
const MAX_MATCH_READS = 4000;
const MAX_MATCH_WRITES = 1500;
const LOOKAHEAD_MS = 12 * 60 * 60_000;
const MIN_LEAD_MS = 5 * 60_000;

type Candidate = {
  slot: Doc<"slots">;
  priceMinor: number;
  auction: Doc<"auctions"> | null;
  lastMinuteDiscount: boolean;
};

function usd(minor: number) {
  return `$${(minor / 100).toFixed(2)}`;
}

function reasonFor(
  trigger: WatchTrigger,
  rule: Doc<"watchRules">,
  billboard: Doc<"billboards">,
  slots: Candidate[],
  previous: Map<string, number | null>,
  now: number,
): string {
  const cheapest = Math.min(...slots.map((s) => s.priceMinor));
  const first = slots[0];
  const n = slots.length;
  const plural = n === 1 ? "slot" : "slots";
  switch (trigger) {
    case "available":
      return `${n} ${plural} on ${billboard.name} fit "${rule.name}": from ${usd(cheapest)}, under your ${usd(rule.maxPriceMinor)} max.`;
    case "price_drop": {
      const was = previous.get(first.slot._id);
      return `Price dropped on ${billboard.name}: now ${usd(first.priceMinor)}${was ? ` (was ${usd(was)})` : ""}, under your ${usd(rule.maxPriceMinor)} max.`;
    }
    case "last_minute":
      return `Last-minute deal on ${billboard.name}: starts in ${Math.max(0, Math.round((first.slot.startAt - now) / 60_000))} min, discounted to ${usd(first.priceMinor)}.`;
    case "auction_open":
      return `Auction opened on ${billboard.name} at ${usd(first.priceMinor)}; bid before it closes.`;
  }
}

/** Load priced candidates for one billboard (available slots, plus slots under an open auction). */
async function candidatesFor(
  ctx: MutationCtx,
  billboard: Doc<"billboards">,
  slots: Doc<"slots">[],
  now: number,
): Promise<Candidate[]> {
  const live = slots.filter((s) => s.state === "available" && s.startAt > now + MIN_LEAD_MS);
  if (live.length === 0) return [];
  const { price } = await computeScreenPrice(ctx.db, billboard, live, now);
  const out: Candidate[] = [];
  for (let i = 0; i < live.length; i++) {
    const slot = live[i];
    const auction = slot.auctionId ? await ctx.db.get(slot.auctionId) : null;
    const open = auction?.status === "open" ? auction : null;
    const scarcity = price.slotPrices[i].stages.find((s) => s.key === "scarcity");
    out.push({
      slot,
      priceMinor: open ? open.currentMinor : price.slotPrices[i].amountMinor,
      auction: open,
      lastMinuteDiscount: !!scarcity && scarcity.effective < 1 && slot.startAt - now < LAST_MINUTE_WINDOW_MS,
    });
  }
  return out;
}

/** Create one alert and schedule its webhook (if the rule delivers to an agent). */
async function createAlert(
  ctx: MutationCtx,
  rule: Doc<"watchRules">,
  trigger: WatchTrigger,
  billboard: Doc<"billboards">,
  matched: Candidate[],
  reason: string,
  now: number,
): Promise<Id<"alerts">> {
  // Show the best deals (cheapest, then soonest), listed in air-time order.
  const shown = [...matched]
    .sort((a, b) => a.priceMinor - b.priceMinor || a.slot.startAt - b.slot.startAt)
    .slice(0, MAX_SLOTS_PER_ALERT)
    .sort((a, b) => a.slot.startAt - b.slot.startAt);
  let agent: Doc<"alerts">["agent"] = undefined;
  if (rule.delivery.includes("agent")) {
    const key = rule.agentKeyId ? await ctx.db.get(rule.agentKeyId) : null;
    agent =
      key && keyStatus(key, now) === "active" && key.webhookUrl
        ? { status: "pending", attempts: 0 }
        : { status: "failed", attempts: 0, lastError: "Agent key is revoked, expired or has no webhook URL" };
  }
  const alertId = await ctx.db.insert("alerts", {
    advertiserId: rule.advertiserId,
    ruleId: rule._id,
    campaignId: rule.campaignId,
    trigger,
    billboardId: billboard._id,
    workspaceId: billboard.workspaceId,
    slotIds: shown.map((c) => c.slot._id),
    slots: shown.map((c) => ({ slotId: c.slot._id, startAt: c.slot.startAt, endAt: c.slot.endAt, screenPriceMinor: c.priceMinor })),
    matchCount: matched.length,
    priceMinor: Math.min(...matched.map((c) => c.priceMinor)),
    auctionId: trigger === "auction_open" ? (shown[0].auction?._id ?? undefined) : undefined,
    reason,
    createdAt: now,
    inbox: { status: "delivered" },
    agent,
  });
  if (agent?.status === "pending") {
    await ctx.scheduler.runAfter(0, internal.watchDelivery.deliver, { alertId });
  }
  return alertId;
}

/**
 * The matcher. Scope: specific slots (events), specific billboards (new
 * inventory), or everything upcoming (sweep). Returns what it did.
 */
export async function runMatcher(
  ctx: MutationCtx,
  scope: {
    slotIds?: Id<"slots">[];
    billboardIds?: Id<"billboards">[];
    ruleId?: Id<"watchRules">;
    /** Slots just came back on sale (hold released/expired): "available" may fire again. */
    reopened?: boolean;
  },
  now: number,
): Promise<{ rulesChecked: number; slotsChecked: number; alertsCreated: number }> {
  const rules = scope.ruleId
    ? [await ctx.db.get(scope.ruleId)].filter((r): r is Doc<"watchRules"> => r !== null && r.active)
    : await ctx.db
        .query("watchRules")
        .withIndex("by_active", (q) => q.eq("active", true))
        .take(MAX_RULES);
  if (rules.length === 0) return { rulesChecked: 0, slotsChecked: 0, alertsCreated: 0 };

  // Which slots, grouped per billboard.
  const perBillboard = new Map<Id<"billboards">, Doc<"slots">[]>();
  if (scope.slotIds) {
    for (const id of scope.slotIds.slice(0, MAX_SLOTS_PER_BILLBOARD)) {
      const s = await ctx.db.get(id);
      if (s) perBillboard.set(s.billboardId, [...(perBillboard.get(s.billboardId) ?? []), s]);
    }
  } else {
    for (const billboardId of (scope.billboardIds ?? []).slice(0, 5)) {
      const slots = await ctx.db
        .query("slots")
        .withIndex("by_billboard_and_startAt", (q) =>
          q.eq("billboardId", billboardId).gt("startAt", now + MIN_LEAD_MS).lte("startAt", now + LOOKAHEAD_MS),
        )
        .take(MAX_SLOTS_PER_BILLBOARD);
      perBillboard.set(billboardId, slots);
    }
  }

  const campaigns = new Map<Id<"campaigns">, Doc<"campaigns"> | null>();
  let writes = 0;
  let reads = 0;
  let slotsChecked = 0;
  let alertsCreated = 0;
  for (const [billboardId, slots] of perBillboard) {
    const billboard = await ctx.db.get(billboardId);
    if (!billboard || billboard.deviceStatus !== "online") continue;
    const candidates = await candidatesFor(ctx, billboard, slots, now);
    slotsChecked += candidates.length;
    if (candidates.length === 0) continue;

    for (const rule of rules) {
      if (writes >= MAX_MATCH_WRITES || reads >= MAX_MATCH_READS) break;
      if (!campaigns.has(rule.campaignId)) campaigns.set(rule.campaignId, await ctx.db.get(rule.campaignId));
      const campaign = campaigns.get(rule.campaignId);
      if (!campaign || campaign.status === "completed" || campaign.status === "cancelled") continue;
      const screen = {
        billboardId: billboard._id,
        city: billboard.city,
        utcOffsetMinutes: billboard.utcOffsetMinutes,
        matchScore: matchScore(billboard.audienceTags, campaign.targetAudience),
      };
      const groups = new Map<string, { trigger: WatchTrigger; items: Candidate[] }>();
      const previous = new Map<string, number | null>();
      for (const c of candidates) {
        if (!ruleFitsSlot(rule, screen, c.slot.startAt)) continue;
        const facts = {
          startAt: c.slot.startAt,
          available: c.slot.state === "available",
          auctionOpen: c.auction !== null,
          priceMinor: c.priceMinor,
          previousPriceMinor: null as number | null,
          lastMinuteDiscount: c.lastMinuteDiscount,
        };
        // Only touch dedupe memory when something could fire or a price must be remembered.
        const tracksPrice = rule.triggers.includes("price_drop");
        if (!tracksPrice && triggersFor(rule, facts, now).length === 0) continue;
        if (reads >= MAX_MATCH_READS) break;
        reads++;
        const memory = await ctx.db
          .query("watchMatches")
          .withIndex("by_rule_and_slot", (q) => q.eq("ruleId", rule._id).eq("slotId", c.slot._id))
          .unique();
        const prev = memory?.lastPriceMinor ?? null;
        previous.set(c.slot._id, prev);
        const already = new Set(memory?.fired ?? []);
        if (scope.reopened) already.delete("available");
        const fresh = triggersFor(rule, { ...facts, previousPriceMinor: prev }, now).filter((t) => !already.has(t));
        // Remember the price (needed for price_drop) and what fired; skip writes that change nothing.
        const needsPrice = tracksPrice && prev !== c.priceMinor;
        if (fresh.length > 0 || needsPrice) {
          if (memory) {
            const fired = [...new Set([...memory.fired, ...fresh])];
            await ctx.db.patch(memory._id, { lastPriceMinor: c.priceMinor, fired, updatedAt: now });
          } else {
            await ctx.db.insert("watchMatches", { ruleId: rule._id, slotId: c.slot._id, lastPriceMinor: c.priceMinor, fired: fresh, updatedAt: now });
          }
          writes++;
        }
        for (const t of fresh) {
          const key = t === "auction_open" ? `${t}:${c.auction?._id}` : t;
          const g = groups.get(key) ?? { trigger: t, items: [] };
          g.items.push(c);
          groups.set(key, g);
        }
      }
      for (const g of groups.values()) {
        await createAlert(ctx, rule, g.trigger, billboard, g.items, reasonFor(g.trigger, rule, billboard, g.items, previous, now), now);
        alertsCreated++;
      }
    }
  }
  return { rulesChecked: rules.length, slotsChecked, alertsCreated };
}

const matchSummary = v.object({ rulesChecked: v.number(), slotsChecked: v.number(), alertsCreated: v.number() });

/** Event-driven entry point (scheduled by inventory, hold and auction code). */
export const match = internalMutation({
  args: {
    slotIds: v.optional(v.array(v.id("slots"))),
    billboardIds: v.optional(v.array(v.id("billboards"))),
    ruleId: v.optional(v.id("watchRules")),
    reopened: v.optional(v.boolean()),
    reason: v.string(),
  },
  returns: matchSummary,
  handler: async (ctx, args) =>
    runMatcher(
      ctx,
      { slotIds: args.slotIds, billboardIds: args.billboardIds, ruleId: args.ruleId, reopened: args.reopened },
      Date.now(),
    ),
});

/**
 * 5-minute sweep (crons.ts): fans out one bounded matcher run per online
 * screen. Catches price moves from crowd and events, and slots entering the
 * last-minute window.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx) => {
    const anyRule = await ctx.db
      .query("watchRules")
      .withIndex("by_active", (q) => q.eq("active", true))
      .first();
    if (!anyRule) return { scheduled: 0 };
    const billboards = await ctx.db.query("billboards").take(MAX_SWEEP_BILLBOARDS);
    let scheduled = 0;
    for (const b of billboards) {
      if (b.deviceStatus !== "online") continue;
      await ctx.scheduler.runAfter(0, internal.watch.match, { billboardIds: [b._id], reason: "sweep" });
      scheduled++;
    }
    return { scheduled };
  },
});

/** Schedule a matcher run from event code (no-op when nobody is watching). */
export async function scheduleMatch(
  ctx: MutationCtx,
  args: { slotIds?: Id<"slots">[]; billboardIds?: Id<"billboards">[]; reopened?: boolean; reason: string },
): Promise<void> {
  const anyRule = await ctx.db
    .query("watchRules")
    .withIndex("by_active", (q) => q.eq("active", true))
    .first();
  if (!anyRule) return;
  await ctx.scheduler.runAfter(0, internal.watch.match, args);
}
