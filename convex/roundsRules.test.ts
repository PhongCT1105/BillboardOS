import { describe, expect, test } from "vitest";
import { askingPrice, closeOutcome, priceSignals, ruleBasedStrategy } from "./lib/rounds";

describe("price signals", () => {
  test("missing data is listed, never blocks", () => {
    const s = priceSignals({ peakInView: null, usualInView: undefined, eventName: null });
    expect(s.map((x) => [x.key, x.factor])).toEqual([
      ["crowd", null],
      ["event", null],
    ]);
    expect(s[0].reason).toMatch(/no camera/i);
    expect(askingPrice(100, s)).toBe(100);
  });

  test("crowd: in view now ÷ usual, clamped 1×–3×; event 1.2×", () => {
    expect(priceSignals({ peakInView: 6, usualInView: undefined, eventName: null })[0].factor).toBe(2);
    expect(priceSignals({ peakInView: 1, usualInView: 3, eventName: null })[0].factor).toBe(1);
    expect(priceSignals({ peakInView: 30, usualInView: 3, eventName: null })[0].factor).toBe(3);
    const s = priceSignals({ peakInView: 6, usualInView: 3, eventName: "Demo Day" });
    expect(s[1]).toMatchObject({ key: "event", factor: 1.2 });
    expect(askingPrice(100, s)).toBe(240);
  });
});

describe("rule-based agent", () => {
  const c = { floorMinor: 100, askingMinor: 200, match: null, crowd: null, maxPerSpotMinor: 1000, budgetLeftMinor: 1000, balanceMinor: 1000 };

  test("worth = asking × (0.8 + 0.7 × match), unknown match counts as 0.5", () => {
    expect(ruleBasedStrategy(c).amountMinor).toBe(230);
    expect(ruleBasedStrategy({ ...c, match: 1 }).amountMinor).toBe(300);
  });

  test("capped by its limits; still bids between floor and asking", () => {
    expect(ruleBasedStrategy({ ...c, maxPerSpotMinor: 150 }).amountMinor).toBe(150);
    expect(ruleBasedStrategy({ ...c, budgetLeftMinor: 120 }).amountMinor).toBe(120);
    expect(ruleBasedStrategy({ ...c, balanceMinor: 110 }).amountMinor).toBe(110);
  });

  test("passes with a reason below the floor or with an unread wallet", () => {
    expect(ruleBasedStrategy({ ...c, maxPerSpotMinor: 50 })).toMatchObject({ amountMinor: null, reasoning: expect.stringMatching(/floor/) });
    expect(ruleBasedStrategy({ ...c, balanceMinor: null })).toMatchObject({ amountMinor: null, reasoning: expect.stringMatching(/wallet/i) });
  });
});

describe("closeOutcome", () => {
  test("no bids: unsold", () => {
    expect(closeOutcome([], 200, 100)).toEqual({ kind: "unsold" });
  });

  test("one bid pays the lower of its bid and the asking price", () => {
    expect(closeOutcome([{ id: "a", amountMinor: 150, answeredAt: 1 }], 200, 100)).toEqual({
      kind: "sold",
      winnerId: "a",
      runnerUpId: null,
      priceMinor: 150,
    });
    expect(closeOutcome([{ id: "a", amountMinor: 300, answeredAt: 1 }], 200, 100)).toMatchObject({ priceMinor: 200 });
  });

  test("two or more: second price + 1¢, never above its own bid nor below the floor; tie goes to the earlier bid", () => {
    expect(
      closeOutcome(
        [
          { id: "a", amountMinor: 300, answeredAt: 2 },
          { id: "b", amountMinor: 180, answeredAt: 1 },
        ],
        200,
        100,
      ),
    ).toEqual({ kind: "sold", winnerId: "a", runnerUpId: "b", priceMinor: 181 });
    expect(
      closeOutcome(
        [
          { id: "a", amountMinor: 200, answeredAt: 2 },
          { id: "b", amountMinor: 200, answeredAt: 1 },
        ],
        200,
        100,
      ),
    ).toMatchObject({ winnerId: "b", runnerUpId: "a", priceMinor: 200 });
  });
});
