import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules, signedInOperator, joinCompanies } from "./test.setup";
import { combineStages, effectiveMultiplier, priceQuote } from "./lib/pricing";
import { eventStage, marketStage, scarcityStage } from "./lib/stages";
import { matchScore } from "./lib/match";

// 09:07 PDT. slots[0] = 09:15 local ... slots[4] = 10:15 local.
const START = Date.UTC(2026, 9, 25, 16, 7);
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = await signedInOperator(convexTest(schema, modules));
  const seed = await t.mutation(internal.seed.demo, {});
  await joinCompanies(t);
  const slots = await t.query(api.slots.listForBillboard, {
    billboardId: seed.billboardId,
    from: START,
    to: START + 24 * 60 * MIN,
  });
  return { t, seed, slots };
}

describe("combiner", () => {
  test("confidence-weighted product, clamped to floor and ceiling", () => {
    expect(effectiveMultiplier({ key: "event", multiplier: 1.5, confidence: 0.5, explanation: "" })).toBe(1.25);
    const r = combineStages({
      baseRateMinor: 4000,
      reserveFloorMinor: 2000,
      ceilingMinor: 16000,
      stages: [
        { key: "crowd", multiplier: 2, confidence: 1, explanation: "" },
        { key: "time", multiplier: 1.25, confidence: 1, explanation: "" },
        { key: "event", multiplier: 1.5, confidence: 1, explanation: "" },
        { key: "scarcity", multiplier: 1.5, confidence: 1, explanation: "" },
        { key: "market", multiplier: 1.2, confidence: 1, explanation: "" },
      ],
    });
    expect(r.computedMinor).toBe(27000);
    expect(r.amountMinor).toBe(16000);
    expect(r.ceilingApplied).toBe(true);
  });

  test("existing two-stage pricing is unchanged by the refactor", () => {
    const p = priceQuote({
      baseRateMinor: 4000,
      reserveFloorMinor: 2000,
      utcOffsetMinutes: -420,
      slotStartTimes: [Date.UTC(2026, 9, 25, 17, 15)],
      audience: null,
      now: START,
    });
    expect(p.amountMinor).toBe(4000);
    expect(p.slotPrices[0].stages.map((s) => s.key)).toEqual(["crowd", "time"]);
    expect(p.ceilingMinor).toBe(16000);
  });
});

describe("stages", () => {
  const slotAt = Date.UTC(2026, 9, 25, 18, 0);

  test("event uplift: strongest nearby event, clamped to x1.5", () => {
    const none = eventStage(slotAt, []);
    expect(effectiveMultiplier(none)).toBe(1);
    const s = eventStage(slotAt, [
      { name: "Small meetup", startsAt: slotAt - 60 * MIN, endsAt: slotAt + 60 * MIN, upliftMultiplier: 1.1, confidence: 1 },
      { name: "Huge conference", startsAt: slotAt - 60 * MIN, endsAt: slotAt + 60 * MIN, upliftMultiplier: 3, confidence: 0.8, expectedAttendance: 40000 },
    ]);
    expect(s.multiplier).toBe(1.5);
    expect(effectiveMultiplier(s)).toBe(1.4);
    expect(s.explanation).toContain("Huge conference");
    expect(eventStage(slotAt + 3 * 60 * MIN, [{ name: "Over", startsAt: slotAt - 60 * MIN, endsAt: slotAt, upliftMultiplier: 1.3, confidence: 1 }]).multiplier).toBe(1);
  });

  test("scarcity: surge with utilization and interest, last-minute decay, bounded", () => {
    const neighbors = (sold: number, total: number) =>
      Array.from({ length: total }, (_, i) => ({ startAt: slotAt + i * 15 * MIN, state: i < sold ? "booked" : "available" }));
    const calm = scarcityStage({ slotStartAt: slotAt, now: slotAt - 3 * 60 * MIN, neighbors: neighbors(0, 16), liveInterest: 0, available: true });
    expect(calm.multiplier).toBe(1);
    const busy = scarcityStage({ slotStartAt: slotAt, now: slotAt - 3 * 60 * MIN, neighbors: neighbors(8, 16), liveInterest: 2, available: true });
    expect(busy.multiplier).toBe(1.4); // 1 + 0.4*0.5 + 0.1*2
    expect(busy.explanation).toContain("8 of 16 nearby slots");
    expect(busy.explanation).toContain("2 other buyers are looking");
    const hot = scarcityStage({ slotStartAt: slotAt, now: slotAt - 3 * 60 * MIN, neighbors: neighbors(16, 16), liveInterest: 5, available: true });
    expect(hot.multiplier).toBe(1.5);
    const late = scarcityStage({ slotStartAt: slotAt, now: slotAt - 30 * MIN, neighbors: neighbors(0, 16), liveInterest: 0, available: true });
    expect(late.multiplier).toBe(0.93); // 0.85 + 0.15 * 30/60
    expect(late.explanation).toContain("starting in 30 min");
    const atStart = scarcityStage({ slotStartAt: slotAt, now: slotAt, neighbors: [], liveInterest: 0, available: true });
    expect(atStart.multiplier).toBe(0.85);
    // Someone else wants it: no last-minute discount.
    const wanted = scarcityStage({ slotStartAt: slotAt, now: slotAt - 10 * MIN, neighbors: [], liveInterest: 1, available: true });
    expect(wanted.multiplier).toBe(1.1);
  });

  test("market anchor: mean of recent ratios, clamped, confidence grows with sales", () => {
    expect(marketStage("evening", []).confidence).toBe(0);
    const two = marketStage("evening", [{ normalizedRatio: 1.3 }, { normalizedRatio: 1.1 }]);
    expect(two.multiplier).toBe(1.2);
    expect(two.confidence).toBe(0.4);
    expect(effectiveMultiplier(two)).toBe(1.08);
    expect(marketStage("night", [{ normalizedRatio: 0.5 }]).multiplier).toBe(0.9);
  });

  test("match score: share of the screen audience the campaign wants", () => {
    const moscone = { software: 0.6, startups: 0.2, tourists: 0.2 };
    expect(matchScore(moscone, { software: 1 })).toBe(0.6);
    expect(matchScore(moscone, { software: 0.5, startups: 0.5 })).toBe(0.8);
    expect(matchScore(moscone, { finance: 1 })).toBe(0);
    expect(matchScore(undefined, { software: 1 })).toBeNull();
  });
});

describe("quotes use every screen stage", () => {
  test("quote stores a five-stage breakdown per slot", async () => {
    const { t, seed, slots } = await setup();
    const q = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[4]._id] });
    expect(q.priceBreakdown).toHaveLength(1);
    expect(q.priceBreakdown[0].stages.map((s) => s.key)).toEqual(["crowd", "time", "event", "scarcity", "market"]);
    expect(q.priceBreakdown[0].screenMinor).toBe(4000);
    const stored = await t.run(async (ctx) => ctx.db.get(q.quoteId));
    expect(stored?.priceBreakdown?.[0].slotId).toBe(slots[4]._id);
    expect(stored?.screenAmountMinor).toBe(4000);
  });

  test("event uplift, other buyers' interest and last-minute decay move the price", async () => {
    const { t, seed, slots } = await setup();
    await t.mutation(internal.seed.pricingDemo, {}); // conference 08:00-18:00 local today, x1.3 @ 0.8
    const withEvent = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[4]._id] });
    expect(withEvent.amountMinor).toBe(4960); // 4000 x 1.24
    expect(withEvent.pricingBasis.join(" ")).toContain("DevWorld Summit");

    // Another campaign is quoting slots[6]; our quote for it surges.
    const other = await t.mutation(api.campaigns.create, {
      advertiserId: seed.advertiserIds[1],
      brief: "competing buyer",
      budgetMinor: 100_000,
    });
    await t.mutation(api.quotes.create, { campaignId: other, slotIds: [slots[6]._id] });
    const contested = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[6]._id] });
    const scarcity = contested.priceBreakdown[0].stages.find((s) => s.key === "scarcity")!;
    expect(scarcity.effective).toBe(1.1);
    expect(scarcity.explanation).toContain("1 other buyer is looking");

    // slots[0] airs in 8 min and nobody wants it: last-minute discount.
    const late = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[0]._id] });
    const lateStage = late.priceBreakdown[0].stages.find((s) => s.key === "scarcity")!;
    expect(lateStage.effective).toBe(0.87);
  });

  test("market history anchors later quotes in the same hour band", async () => {
    const { t, seed, slots } = await setup();
    // Sell three late-morning slots at a premium via the manual payment path.
    for (const [i, key] of [[4, "a"], [5, "b"], [6, "c"]] as const) {
      const q = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[i]._id] });
      const h = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: key, actor: "buyer" });
      await t.mutation(api.payments.recordManual, { holdId: h.holdId, note: "history" });
    }
    const history = await t.run(async (ctx) => ctx.db.query("priceHistory").collect());
    expect(history).toHaveLength(3);
    expect(history.every((h) => h.hourBand === "late-morning" && h.kind === "posted")).toBe(true);
    const q = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[8]._id] });
    const market = q.priceBreakdown[0].stages.find((s) => s.key === "market")!;
    expect(market.confidence).toBeCloseTo(0.6);
    expect(market.explanation).toContain("3 recent sales in the late-morning band");
  });
});

describe("billboards.recommend", () => {
  test("ranks by match x expected audience and explains it", async () => {
    const { t, seed } = await setup();
    const rows = await t.query(api.billboards.recommend, { targetAudience: { software: 1 } });
    expect(rows[0]).toMatchObject({
      billboardId: seed.billboardId,
      matchScore: 0.6,
      expectedAudiencePer15Min: 120,
      audienceBasis: "normal_traffic",
      relevantViewersPer15Min: 72,
    });
    expect(rows[0].explanation).toContain("software 60%");
    const finance = await t.query(api.billboards.recommend, { targetAudience: { finance: 1 } });
    expect(finance[0].matchScore).toBe(0);
  });
});
