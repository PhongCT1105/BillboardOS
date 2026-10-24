import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules, signedInOperator, type TestClient, joinCompanies } from "./test.setup";
import { demandFromAudience, trailingAudience, LOW_COVERAGE_CONFIDENCE_CAP } from "./lib/pricing";

// 09:07 PDT; current audience bucket starts 16:00Z; first slot 16:15Z (hour factor 1.0, base $40).
const START = Date.UTC(2026, 9, 25, 16, 7);
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code: string }).code;
    throw error;
  }
  throw new Error("expected promise to reject");
}

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

describe("audience.addArrivals", () => {
  test("accumulates within a bucket and rolls over to the next", async () => {
    const { t, seed } = await setup();
    const add = (arrivals: number, peakInView: number) =>
      t.mutation(api.audience.addArrivals, {
        billboardId: seed.billboardId,
        arrivals,
        peakInView,
        confidence: 0.8,
        source: "camera",
      });
    const a = await add(5, 3);
    const b = await add(7, 2);
    expect(b.aggregateId).toBe(a.aggregateId);
    expect(b).toMatchObject({ countEstimate: 12, peakInView: 3, bucketStart: Date.UTC(2026, 9, 25, 16, 0) });
    const c = await add(0, 6);
    expect(c).toMatchObject({ countEstimate: 12, peakInView: 6 });

    vi.setSystemTime(START + 10 * MIN); // 16:17Z -> next bucket
    const d = await add(4, 1);
    expect(d.aggregateId).not.toBe(a.aggregateId);
    expect(d).toMatchObject({ countEstimate: 4, peakInView: 1, bucketStart: Date.UTC(2026, 9, 25, 16, 15) });

    const rows = await t.query(api.audience.recentForBillboard, { billboardId: seed.billboardId });
    expect(rows.map((r) => [r.countEstimate, r.peakInView])).toEqual([
      [12, 6],
      [4, 1],
    ]);
  });

  test("rejects out-of-bounds input", async () => {
    const { t, seed } = await setup();
    const base = { billboardId: seed.billboardId, arrivals: 1, peakInView: 1, confidence: 0.5, source: "camera" as const };
    for (const bad of [
      { arrivals: 501 },
      { arrivals: -1 },
      { arrivals: 1.5 },
      { peakInView: 501 },
      { confidence: 1.2 },
      { confidence: Number.NaN },
    ]) {
      expect(await errorCode(t.mutation(api.audience.addArrivals, { ...base, ...bad }))).toBe("INVALID_INPUT");
    }
  });
});

describe("per-billboard audience baseline", () => {
  test("baseline changes the demand multiplier", () => {
    const sample = { countEstimate: 30, bucketStart: START, source: "camera" as const, confidence: 1 };
    expect(demandFromAudience(sample, START).multiplier).toBe(0.8); // 30/120 clamped
    const quiet = demandFromAudience(sample, START, 20);
    expect(quiet.multiplier).toBe(1.5); // 30/20
    expect(quiet.basis.join(" ")).toContain("20 people per 15 min is normal here");
  });

  test("setAudienceBaseline changes the quote price and is audited", async () => {
    const { t, seed, slots } = await setup();
    await t.mutation(api.audience.addArrivals, {
      billboardId: seed.billboardId,
      arrivals: 30,
      peakInView: 4,
      confidence: 1,
      source: "camera",
    });
    vi.setSystemTime(START + 2 * MIN); // 9 of 15 trailing minutes measured -> full confidence
    const before = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[4]._id] });
    expect(before.amountMinor).toBe(3200); // $40 x0.80
    expect(before.pricingBasis.join(" ")).toContain("120 people per 15 min is normal here");

    expect(
      await errorCode(t.mutation(api.billboards.setAudienceBaseline, { billboardId: seed.billboardId, peoplePer15Min: 0 })),
    ).toBe("INVALID_INPUT");
    expect(
      await errorCode(t.mutation(api.billboards.setAudienceBaseline, { billboardId: seed.billboardId, peoplePer15Min: 2.5 })),
    ).toBe("INVALID_INPUT");
    const set = await t.mutation(api.billboards.setAudienceBaseline, { billboardId: seed.billboardId, peoplePer15Min: 20 });
    expect(set).toMatchObject({ previous: 120, audienceBaselinePerBucket: 20 });

    const after = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[4]._id] });
    expect(after.amountMinor).toBe(6000); // $40 x1.50
    expect(after.pricingBasis.join(" ")).toContain("20 people per 15 min is normal here");

    const view = await t.query(api.player.nowPlaying, { billboardId: seed.billboardId, atMinute: START + 2 * MIN });
    expect(view.houseAd.fromPriceMinor).toBe(5100); // cheapest: $40 x1.50 x0.85 evening

    const events = await t.query(api.audit.recent, {});
    const changed = events.find((e) => e.type === "billboard.baseline_changed")!;
    expect(changed.data).toMatchObject({ previous: 120, next: 20 });
  });
});

describe("trailing 15-minute audience window", () => {
  const bucket = (startMin: number, count: number, confidence = 1) => ({
    bucketStart: Date.UTC(2026, 9, 25, 16, startMin),
    countEstimate: count,
    source: "camera" as const,
    confidence,
  });
  const at = (h: number, m: number) => Date.UTC(2026, 9, 25, h, m);

  test("5 min into a bucket: current + previous x 10/15", () => {
    const s = trailingAudience([bucket(15, 6), bucket(0, 30)], at(16, 20))!;
    expect(s.countEstimate).toBe(26);
    expect(s.window?.coverage).toBe(1);
    expect(s.confidence).toBe(1);
  });

  test("no previous bucket: current only, low confidence while under half covered", () => {
    const early = trailingAudience([bucket(15, 6)], at(16, 20))!;
    expect(early.countEstimate).toBe(6);
    expect(early.window?.coverage).toBeCloseTo(5 / 15);
    expect(early.confidence).toBe(LOW_COVERAGE_CONFIDENCE_CAP);
    expect(demandFromAudience(early, at(16, 20)).confidence).toBe("low");

    const later = trailingAudience([bucket(15, 6)], at(16, 25))!;
    expect(later.countEstimate).toBe(6);
    expect(later.confidence).toBe(1);
  });

  test("previous only (no reading yet this bucket), and nothing at all", () => {
    const s = trailingAudience([bucket(0, 30)], at(16, 20))!;
    expect(s.countEstimate).toBe(20);
    expect(s.confidence).toBe(1);
    expect(trailingAudience([bucket(0, 30)], at(16, 40))).toBeNull(); // 2 buckets ago: outside window
    expect(trailingAudience([], at(16, 20))).toBeNull();
  });

  test("quotes use the trailing window and say so", async () => {
    const { t, seed, slots } = await setup();
    const add = (arrivals: number) =>
      t.mutation(api.audience.addArrivals, {
        billboardId: seed.billboardId,
        arrivals,
        peakInView: 1,
        confidence: 1,
        source: "camera",
      });
    await add(30); // 16:07 -> bucket 16:00
    vi.setSystemTime(at(16, 20));
    await add(6); // bucket 16:15
    await t.mutation(api.billboards.setAudienceBaseline, { billboardId: seed.billboardId, peoplePer15Min: 20 });
    // slots[5] airs 10:30 local (more than an hour out): no last-minute discount.
    const q = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[5]._id] });
    expect(q.pricingBasis.join(" ")).toContain("Audience 26 people in the last 15 min");
    expect(q.amountMinor).toBe(5200); // $40 x1.30 (26/20) x1.0
  });
});
