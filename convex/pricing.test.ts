import { describe, expect, test } from "vitest";
import {
  AUDIENCE_STALE_AFTER_MS,
  BASELINE_AUDIENCE_PER_BUCKET,
  HOUR_FACTORS,
  demandFromAudience,
  hourFactorFor,
  priceQuote,
} from "./lib/pricing";

const NOW = Date.UTC(2026, 9, 25, 16, 7); // 09:07 PDT
const PDT = -420;
// 09:15 PDT -> hour factor 1.0
const SLOT_9AM = Date.UTC(2026, 9, 25, 16, 15);
// 02:00 PDT -> overnight factor 0.6
const SLOT_2AM = Date.UTC(2026, 9, 26, 9, 0);

describe("pricing", () => {
  test("missing audience -> baseline price, low confidence", () => {
    const price = priceQuote({
      baseRateMinor: 4000,
      reserveFloorMinor: 2000,
      utcOffsetMinutes: PDT,
      slotStartTimes: [SLOT_9AM],
      audience: null,
      now: NOW,
    });
    expect(price.amountMinor).toBe(4000);
    expect(price.demandMultiplier).toBe(1);
    expect(price.confidence).toBe("low");
    expect(price.pricingBasis.join("\n")).toMatch(/No recent audience data/);
  });

  test("stale audience is ignored -> baseline, low confidence", () => {
    const demand = demandFromAudience(
      {
        countEstimate: 1000,
        bucketStart: NOW - AUDIENCE_STALE_AFTER_MS - 1,
        source: "camera",
        confidence: 0.9,
      },
      NOW,
    );
    expect(demand.multiplier).toBe(1);
    expect(demand.confidence).toBe("low");
  });

  test("price is never below the reserve floor", () => {
    const audiences = [
      null,
      { countEstimate: 0, bucketStart: NOW, source: "camera" as const, confidence: 1 },
      { countEstimate: 5, bucketStart: NOW, source: "simulated" as const, confidence: 0.3 },
      { countEstimate: 10_000, bucketStart: NOW, source: "camera" as const, confidence: 1 },
    ];
    for (const base of [0, 500, 2000, 2100, 4000]) {
      for (const floor of [0, 1500, 2000, 9999]) {
        for (const audience of audiences) {
          for (let hour = 0; hour < 24; hour++) {
            const start = Date.UTC(2026, 9, 25, 7, 0) + hour * 3600_000; // 00:00 PDT + h
            const price = priceQuote({
              baseRateMinor: base,
              reserveFloorMinor: floor,
              utcOffsetMinutes: PDT,
              slotStartTimes: [start],
              audience,
              now: NOW,
            });
            expect(price.amountMinor).toBeGreaterThanOrEqual(floor);
            expect(Number.isSafeInteger(price.amountMinor)).toBe(true);
          }
        }
      }
    }
  });

  test("overnight discount is raised to the floor", () => {
    const price = priceQuote({
      baseRateMinor: 3000,
      reserveFloorMinor: 2000,
      utcOffsetMinutes: PDT,
      slotStartTimes: [SLOT_2AM],
      audience: null,
      now: NOW,
    });
    // 3000 * 0.6 = 1800 < 2000
    expect(price.amountMinor).toBe(2000);
    expect(price.slotPrices[0].floorApplied).toBe(true);
    expect(price.pricingBasis.join("\n")).toMatch(/reserve floor/);
  });

  test("more audience -> higher price, clamped, deterministic", () => {
    const at = (count: number) =>
      priceQuote({
        baseRateMinor: 4000,
        reserveFloorMinor: 2000,
        utcOffsetMinutes: PDT,
        slotStartTimes: [SLOT_9AM],
        audience: { countEstimate: count, bucketStart: NOW - 60_000, source: "camera", confidence: 1 },
        now: NOW,
      });
    const base = at(BASELINE_AUDIENCE_PER_BUCKET);
    const busy = at(BASELINE_AUDIENCE_PER_BUCKET * 1.5);
    const packed = at(BASELINE_AUDIENCE_PER_BUCKET * 100);
    expect(base.amountMinor).toBe(4000);
    expect(busy.amountMinor).toBe(6000);
    expect(packed.amountMinor).toBe(8000); // clamped at x2.0
    expect(packed.confidence).toBe("high");
    expect(at(180)).toEqual(at(180));
  });

  test("simulated / low-confidence audience moves price less and is labeled", () => {
    const price = priceQuote({
      baseRateMinor: 4000,
      reserveFloorMinor: 2000,
      utcOffsetMinutes: PDT,
      slotStartTimes: [SLOT_9AM],
      audience: { countEstimate: 240, bucketStart: NOW, source: "simulated", confidence: 0.5 },
      now: NOW,
    });
    // raw x2.0, weighted by 0.5 -> x1.5
    expect(price.demandMultiplier).toBe(1.5);
    expect(price.amountMinor).toBe(6000);
    expect(price.confidence).toBe("medium");
    expect(price.pricingBasis.join("\n")).toMatch(/SIMULATED/);
  });

  test("hour factor table covers every hour", () => {
    expect(HOUR_FACTORS).toHaveLength(24);
    expect(hourFactorFor(SLOT_9AM, PDT)).toBe(1.0);
    expect(hourFactorFor(SLOT_2AM, PDT)).toBe(0.6);
  });
});
