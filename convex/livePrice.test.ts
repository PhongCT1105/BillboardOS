import { describe, expect, test } from "vitest";
import { livePrice, referenceCpm } from "./lib/livePrice";

const base = { peopleInView: 10, spotMs: 12 * 60_000, cpmRefMinor: 500, bestMatch: 0.375, idleMs: 0, msUntilStart: 15 * 60_000, reofferRound: 0, minimumMinor: 25, jitter: 0 };

describe("livePrice", () => {
  test("worked example: 10 people x 24 plays at $5 CPM = $1.20, opens at 60%", () => {
    const p = livePrice(base);
    expect(p.plays).toBe(24);
    expect(p.impressions).toBe(240);
    expect(p.relevance).toBe(1);
    expect(p.valueMinor).toBe(120);
    expect(p.openingMinor).toBe(72);
    expect(p.why).toBe("10 people × 24 plays at $5.00 per 1,000 views × 1.00 fit ≈ $1.20; idle 0 min; bidding opens at $0.72 (minimum $0.25)");
  });
  test("spot starting now is 10% cheaper; each idle 15 min is 10% cheaper, at most 5 periods", () => {
    expect(livePrice({ ...base, msUntilStart: 0 }).openingMinor).toBe(65);
    expect(livePrice({ ...base, idleMs: 30 * 60_000 }).openingMinor).toBe(58);
    expect(livePrice({ ...base, idleMs: 10 * 60 * 60_000 }).openingMinor).toBe(livePrice({ ...base, idleMs: 75 * 60_000 }).openingMinor);
  });
  test("a large crowd pauses the idle and start discounts", () => {
    const p = livePrice({ ...base, peopleInView: 25, idleMs: 60 * 60_000, msUntilStart: 0 });
    expect(p.openingMinor).toBe(Math.round(p.valueMinor * 0.6));
  });
  test("re-offers step down 15% and never go below the minimum", () => {
    expect(livePrice({ ...base, reofferRound: 1 }).openingMinor).toBe(61);
    expect(livePrice({ ...base, reofferRound: 20 }).openingMinor).toBe(25);
    expect(livePrice({ ...base, reofferRound: 1 }).why).toContain("; re-offer 1");
  });
  test("value below the minimum opens at the minimum; opening never exceeds value", () => {
    expect(livePrice({ ...base, peopleInView: 1 }).openingMinor).toBe(25);
    expect(livePrice({ ...base, jitter: 0.5 }).openingMinor).toBe(74); // jitter clamped to +3%
  });
  test("relevance is clamped to 0.7..1.5", () => {
    expect(livePrice({ ...base, bestMatch: 0 }).relevance).toBe(0.7);
    expect(livePrice({ ...base, bestMatch: 1 }).relevance).toBe(1.5);
  });
});

describe("referenceCpm", () => {
  test("starting rate until 5 sales, then the median implied CPM", () => {
    const sale = (amountMinor: number) => ({ amountMinor, impressions: 200 });
    expect(referenceCpm([sale(100), sale(100)], 500)).toBe(500);
    expect(referenceCpm([sale(100), sale(120), sale(140), sale(160), sale(180)], 500)).toBe(700);
    expect(referenceCpm([sale(100), { amountMinor: 999, impressions: 0 }], 500)).toBe(500);
  });
});
