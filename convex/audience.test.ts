import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules, signedInOperator, type TestClient, joinCompanies, quoteFor } from "./test.setup";

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
