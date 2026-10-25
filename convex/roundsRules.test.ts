import { describe, expect, test } from "vitest";
import { askingPrice, companyOffer, hostReply, priceSignals, ruleBasedStrategy } from "./lib/rounds";

describe("price signals", () => {
  test("missing data is listed, never blocks", () => {
    const s = priceSignals({ peakInView: null, usualInView: undefined, eventName: null, recentSales: 0 });
    expect(s.map((x) => [x.key, x.factor])).toEqual([
      ["crowd", null],
      ["event", null],
      ["demand", null],
    ]);
    expect(s[0].reason).toMatch(/no camera/i);
    expect(askingPrice(100, s)).toBe(100);
  });

  test("crowd: in view now ÷ usual, clamped 1×–3×; event 1.2×", () => {
    expect(priceSignals({ peakInView: 6, usualInView: undefined, eventName: null, recentSales: 0 })[0].factor).toBe(2);
    expect(priceSignals({ peakInView: 1, usualInView: 3, eventName: null, recentSales: 0 })[0].factor).toBe(1);
    expect(priceSignals({ peakInView: 30, usualInView: 3, eventName: null, recentSales: 0 })[0].factor).toBe(3);
    const s = priceSignals({ peakInView: 6, usualInView: 3, eventName: "Demo Day", recentSales: 0 });
    expect(s[1]).toMatchObject({ key: "event", factor: 1.2 });
    expect(askingPrice(100, s)).toBe(240);
  });

  test("demand: each sale here in the last 2 h adds 10%, up to 1.5x; companies get their own factor, never under the floor", () => {
    expect(priceSignals({ peakInView: null, usualInView: undefined, eventName: null, recentSales: 0 })[2]).toMatchObject({ key: "demand", factor: null });
    expect(priceSignals({ peakInView: null, usualInView: undefined, eventName: null, recentSales: 3 })[2].factor).toBe(1.3);
    expect(priceSignals({ peakInView: null, usualInView: undefined, eventName: null, recentSales: 9 })[2].factor).toBe(1.5);
    expect(companyOffer(200, 100, 1.25)).toBe(250);
    expect(companyOffer(100, 100, 0.8)).toBe(100);
  });
});

describe("rule-based agent", () => {
  const c = { floorMinor: 100, priceMinor: 200, maxPerSpotMinor: 1000, budgetLeftMinor: 1000, balanceMinor: 1000 };

  test("takes the host's price when it fits every limit", () => {
    expect(ruleBasedStrategy(c)).toMatchObject({ amountMinor: 200 });
  });

  test("over a limit: offers the most it can pay, at or above the floor", () => {
    expect(ruleBasedStrategy({ ...c, maxPerSpotMinor: 150 })).toMatchObject({ amountMinor: 150 });
    expect(ruleBasedStrategy({ ...c, budgetLeftMinor: 120 }).reasoning).toMatch(/budget left today/);
    expect(ruleBasedStrategy({ ...c, balanceMinor: 110 })).toMatchObject({ amountMinor: 110 });
  });

  test("passes with a reason under the floor or with an unread wallet", () => {
    expect(ruleBasedStrategy({ ...c, maxPerSpotMinor: 50 })).toMatchObject({ amountMinor: null });
    expect(ruleBasedStrategy({ ...c, balanceMinor: null }).reasoning).toMatch(/wallet/i);
  });
});

describe("hostReply", () => {
  test("at or above the price: a deal at the price", () => {
    expect(hostReply({ amountMinor: 250, priceMinor: 200, countered: false })).toEqual({ kind: "deal", priceMinor: 200 });
  });

  test("under the price: one counter halfway, then the next offer is a deal", () => {
    expect(hostReply({ amountMinor: 120, priceMinor: 200, countered: false })).toEqual({ kind: "counter", priceMinor: 160 });
    expect(hostReply({ amountMinor: 130, priceMinor: 160, countered: true })).toEqual({ kind: "deal", priceMinor: 130 });
  });

  test("a cent apart: no point countering", () => {
    expect(hostReply({ amountMinor: 199, priceMinor: 200, countered: false })).toEqual({ kind: "deal", priceMinor: 199 });
  });
});
