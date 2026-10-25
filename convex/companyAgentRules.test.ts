import { describe, expect, test } from "vitest";
import { BUDGET_MAX_MINOR, BUDGET_MIN_MINOR, agentCap, bidDelayMs, budgetProblem, limitsFromBudget, onAnnounce, onCounter, onUpdate } from "./lib/companyAgent";

describe("agentCap", () => {
  const i = { valueMinor: 120, matchScore: 0.5, maxPerSpotMinor: 1000, budgetLeftMinor: 1000, balanceMinor: 1000 };
  test("value x (0.5 + match), limited by every ceiling", () => {
    expect(agentCap(i)).toBe(120);
    expect(agentCap({ ...i, maxPerSpotMinor: 150 })).toBe(120);
    expect(agentCap({ ...i, maxPerSpotMinor: 100 })).toBe(100);
    expect(agentCap({ ...i, balanceMinor: 50 })).toBe(50);
    expect(agentCap({ ...i, budgetLeftMinor: 0 })).toBe(0);
  });
});

describe("onAnnounce", () => {
  const i = { openingMinor: 72, minimumMinor: 25, relevantViewers: 5, minRelevantViewers: 3, cap: 120 };
  test("accept, counter or pass on price", () => {
    expect(onAnnounce(i).decision).toBe("accept");
    expect(onAnnounce({ ...i, cap: 50 })).toMatchObject({ decision: "counter", amountMinor: 40 });
    expect(onAnnounce({ ...i, cap: 20 }).decision).toBe("pass");
  });
  test("passes when too few relevant viewers", () => {
    const d = onAnnounce({ ...i, relevantViewers: 2 });
    expect(d.decision).toBe("pass");
    expect(d.reasoning).toContain("under my minimum of 3");
  });
});

describe("onUpdate", () => {
  const i = { youLead: false, bidsLeft: 3, minNextMinor: 82, cap: 120 };
  test("bids the minimum next bid only when it can", () => {
    expect(onUpdate({ ...i, youLead: true })).toBeNull();
    expect(onUpdate({ ...i, bidsLeft: 0 })).toBeNull();
    expect(onUpdate({ ...i, cap: 81 })).toBeNull();
    expect(onUpdate(i)).toEqual({ bidMinor: 82 });
  });
});

describe("onCounter", () => {
  test("accept, split the difference, or pass", () => {
    expect(onCounter({ sellerMinor: 61, lastOfferMinor: 40, cap: 70 }).decision).toBe("accept");
    expect(onCounter({ sellerMinor: 61, lastOfferMinor: 40, cap: 55 })).toMatchObject({ decision: "counter", amountMinor: 51 });
    expect(onCounter({ sellerMinor: 61, lastOfferMinor: 55, cap: 55 }).decision).toBe("pass");
  });
});

describe("bidDelayMs", () => {
  test("300 to 1000 ms", () => {
    expect(bidDelayMs(0)).toBe(300);
    expect(bidDelayMs(1)).toBe(1000);
  });
});

describe("limitsFromBudget", () => {
  test("a spot may take 30% of the day, at least $0.50, never more than the day", () => {
    expect(limitsFromBudget(500)).toEqual({ maxPerSpotMinor: 150, minRelevantViewers: 1 });
    expect(limitsFromBudget(100)).toEqual({ maxPerSpotMinor: 50, minRelevantViewers: 1 });
    expect(limitsFromBudget(2000).maxPerSpotMinor).toBe(600);
  });
  test("rejects budgets outside the slider's range or off its step", () => {
    expect(budgetProblem(BUDGET_MIN_MINOR - 50)).toMatch(/between/);
    expect(budgetProblem(BUDGET_MAX_MINOR + 50)).toMatch(/between/);
    expect(budgetProblem(525)).toMatch(/steps/);
    expect(budgetProblem(500)).toBeNull();
  });
});
