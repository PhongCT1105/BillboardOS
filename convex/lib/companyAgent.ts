/**
 * A company agent's settings (one daily budget slider) and the webhook
 * payload it reads. Pure helpers, integer cents. How it answers an offer is
 * ruleBasedStrategy in lib/rounds.ts.
 */

/** The one spending control an advertiser sets (a slider): a daily budget in these bounds and steps. */
export const BUDGET_MIN_MINOR = 100;
export const BUDGET_MAX_MINOR = 2000;
export const BUDGET_STEP_MINOR = 50;
export const BUDGET_DEFAULT_MINOR = 500;
const SPOT_SHARE = 0.3;
const SPOT_MIN_MINOR = 50;

export function budgetProblem(dailyBudgetMinor: number): string | null {
  if (!Number.isSafeInteger(dailyBudgetMinor) || dailyBudgetMinor < BUDGET_MIN_MINOR || dailyBudgetMinor > BUDGET_MAX_MINOR) {
    return `Daily budget must be between $${BUDGET_MIN_MINOR / 100} and $${BUDGET_MAX_MINOR / 100}`;
  }
  if (dailyBudgetMinor % BUDGET_STEP_MINOR !== 0) return `Daily budget moves in steps of $${(BUDGET_STEP_MINOR / 100).toFixed(2)}`;
  return null;
}

/** Everything else follows from the budget: a spot may take 30% of the day (at least $0.50); one matching person is enough. */
export function limitsFromBudget(dailyBudgetMinor: number): { maxPerSpotMinor: number; minRelevantViewers: number } {
  const maxPerSpotMinor = Math.min(dailyBudgetMinor, Math.max(SPOT_MIN_MINOR, Math.round(dailyBudgetMinor * SPOT_SHARE)));
  return { maxPerSpotMinor, minRelevantViewers: 1 };
}

/** A webhook payload as the company agent reads it (every field optional: it is outside input). */
export type AgentPayload = {
  type?: string;
  // round_offer / round_counter
  roundId?: string;
  floorMinor?: number;
  askingMinor?: number;
  priceMinor?: number;
  // round_won
  holdId?: string;
  amountMinor?: number;
  purchaseUrl?: string;
  links?: { bid?: string };
};

/** Our own deployment's HTTP origin (the agent only ever calls it). */
export function agentSiteUrl(): string {
  return (process.env.CONVEX_SITE_URL ?? "https://billboardos.invalid").replace(/\/$/, "");
}
