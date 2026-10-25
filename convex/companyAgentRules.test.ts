import { describe, expect, test } from "vitest";
import { BUDGET_MAX_MINOR, BUDGET_MIN_MINOR, budgetProblem, limitsFromBudget } from "./lib/companyAgent";

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
