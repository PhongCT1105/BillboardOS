import { describe, expect, test } from "vitest";
import { DEFAULT_WEIGHTS, bestAgreed, brandScore, clampAnswer, hostReply, ruleBasedStrategy, validateWeights, windowPrice } from "./lib/rounds";

describe("window price = a x predicted + b x people + c x brand, clamped to [floor, cap]", () => {
  test("adds the three terms with the default weights", () => {
    const r = windowPrice({ predictedMinor: 100, people: 4, brand: 0.5, floorMinor: 50, w: DEFAULT_WEIGHTS });
    expect(r.priceMinor).toBe(104); // 100 + 0.5 x 4 + 3 x 0.5 = 103.5
    expect(r.terms).toEqual({ modelMinor: 100, peopleMinor: 2, brandMinor: 1.5, capMinor: 200, capped: null });
  });

  test("never above the cap (capMultiplier x predicted), never below the floor", () => {
    const busy = windowPrice({ predictedMinor: 10, people: 100, brand: 1, floorMinor: 5, w: DEFAULT_WEIGHTS });
    expect(busy).toMatchObject({ priceMinor: 20, terms: { capped: "cap", capMinor: 20 } });
    const empty = windowPrice({ predictedMinor: 0, people: null, brand: 0, floorMinor: 5, w: DEFAULT_WEIGHTS });
    expect(empty).toMatchObject({ priceMinor: 5, terms: { capped: "floor" } });
  });

  test("brand value 0..1 from the research factor; weights are bounded", () => {
    expect([0.8, 1.15, 1.5, 2].map(brandScore)).toEqual([0, 0.5, 1, 1]);
    expect(validateWeights(DEFAULT_WEIGHTS)).toBeNull();
    expect(validateWeights({ ...DEFAULT_WEIGHTS, capMultiplier: 0.5 })).toMatch(/capMultiplier/);
  });
});

describe("closing a window", () => {
  test("the highest agreed price wins; a tie goes to who agreed first", () => {
    expect(bestAgreed([])).toBeNull();
    expect(bestAgreed([{ id: "a", amountMinor: 7, agreedAt: 1 }, { id: "b", amountMinor: 9, agreedAt: 5 }])?.id).toBe("b");
    expect(bestAgreed([{ id: "a", amountMinor: 9, agreedAt: 3 }, { id: "b", amountMinor: 9, agreedAt: 2 }])?.id).toBe("b");
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

describe("LLM answers are held to the rules", () => {
  const base = { priceMinor: 9, floorMinor: 5, capMinor: 8, reasoning: "x" };
  test("above the price agrees at the price, above the cap is cut to the cap, under the floor passes", () => {
    expect(clampAnswer({ ...base, capMinor: 20, amountMinor: 50 }).amountMinor).toBe(9);
    expect(clampAnswer({ ...base, amountMinor: 9 }).amountMinor).toBe(8);
    expect(clampAnswer({ ...base, amountMinor: 3 }).amountMinor).toBeNull();
    expect(clampAnswer({ ...base, amountMinor: null }).amountMinor).toBeNull();
    expect(clampAnswer({ ...base, amountMinor: 6.6 }).amountMinor).toBe(7);
  });
});

describe("hostReply", () => {
  test("at or above the price: agreed at the price", () => {
    expect(hostReply({ amountMinor: 250, priceMinor: 200, countered: false })).toEqual({ kind: "deal", priceMinor: 200 });
  });

  test("under the price: one counter halfway, then the next offer is agreed", () => {
    expect(hostReply({ amountMinor: 120, priceMinor: 200, countered: false })).toEqual({ kind: "counter", priceMinor: 160 });
    expect(hostReply({ amountMinor: 130, priceMinor: 160, countered: true })).toEqual({ kind: "deal", priceMinor: 130 });
  });

  test("a cent apart: no point countering", () => {
    expect(hostReply({ amountMinor: 199, priceMinor: 200, countered: false })).toEqual({ kind: "deal", priceMinor: 199 });
  });
});
