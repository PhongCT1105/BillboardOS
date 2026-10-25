/**
 * Fast rule-based tactics for a company's bidding agent in the live auction.
 * Pure helpers, integer cents. The agent never exceeds its cap, which is
 * limited by the per-spot maximum, the remaining budget and the balance.
 */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export type AgentDecision = { decision: "accept" | "counter" | "pass"; amountMinor?: number; reasoning: string };

/** The most the agent will pay for a spot. */
export function agentCap(i: {
  valueMinor: number;
  matchScore: number;
  maxPerSpotMinor: number;
  budgetLeftMinor: number;
  balanceMinor: number;
}): number {
  return Math.max(0, Math.min(Math.round(i.valueMinor * (0.5 + i.matchScore)), i.maxPerSpotMinor, i.budgetLeftMinor, i.balanceMinor));
}

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

/** Said when the wallet hasn't been read yet: the cap can't be trusted, so the agent sits out. */
export const BALANCE_UNKNOWN = "Wallet balance unknown (not read yet), so I can't commit to a price";

/** Reaction to a spot announcement: accept the opening price, counter lower, or pass. */
export function onAnnounce(i: {
  openingMinor: number;
  minimumMinor: number;
  relevantViewers: number;
  minRelevantViewers: number;
  cap: number;
  /** The wallet balance hasn't been read: pass and say so (the cap would be a meaningless 0). */
  balanceUnknown?: boolean;
}): AgentDecision {
  if (i.relevantViewers < i.minRelevantViewers) {
    return { decision: "pass", reasoning: `Only ${i.relevantViewers} relevant viewers, under my minimum of ${i.minRelevantViewers}` };
  }
  if (i.balanceUnknown) return { decision: "pass", reasoning: BALANCE_UNKNOWN };
  if (i.cap >= i.openingMinor) {
    return { decision: "accept", amountMinor: i.openingMinor, reasoning: `Opening price ${i.openingMinor} is within my cap of ${i.cap}` };
  }
  if (i.cap >= i.minimumMinor) {
    const amountMinor = Math.max(i.minimumMinor, Math.round(i.cap * 0.8));
    return { decision: "counter", amountMinor, reasoning: `Opening price ${i.openingMinor} is above my cap of ${i.cap}; countering at ${amountMinor}` };
  }
  return { decision: "pass", reasoning: `My cap of ${i.cap} is below the host minimum of ${i.minimumMinor}` };
}

/** During bidding: raise to the minimum next bid if not leading, bids remain and it fits the cap. */
export function onUpdate(i: { youLead: boolean; bidsLeft: number; minNextMinor: number; cap: number }): { bidMinor: number } | null {
  if (i.youLead || i.bidsLeft <= 0 || i.minNextMinor > i.cap) return null;
  return { bidMinor: i.minNextMinor };
}

/** Reaction to the seller's counter-offer: accept, meet halfway within the cap, or pass. */
export function onCounter(i: { sellerMinor: number; lastOfferMinor: number; cap: number; balanceUnknown?: boolean }): AgentDecision {
  if (i.balanceUnknown) return { decision: "pass", reasoning: BALANCE_UNKNOWN };
  if (i.sellerMinor <= i.cap) {
    return { decision: "accept", amountMinor: i.sellerMinor, reasoning: `Seller's ${i.sellerMinor} is within my cap of ${i.cap}` };
  }
  const amountMinor = Math.min(i.cap, Math.round(i.lastOfferMinor + (i.sellerMinor - i.lastOfferMinor) * 0.5));
  if (amountMinor > i.lastOfferMinor) {
    return { decision: "counter", amountMinor, reasoning: `Seller's ${i.sellerMinor} is above my cap of ${i.cap}; meeting at ${amountMinor}` };
  }
  return { decision: "pass", reasoning: `Seller's ${i.sellerMinor} is above my cap of ${i.cap} and I cannot move up` };
}

/** Human-feeling reaction delay: 300 to 1000 ms. */
export function bidDelayMs(rand: number): number {
  return 300 + Math.floor(clamp(rand, 0, 1) * 700);
}

/** A webhook payload as the company agent reads it (every field optional: it is outside input). */
export type AgentPayload = {
  type?: string;
  offerId?: string;
  // flash_offer
  valueMinor?: number | null;
  openingMinor?: number;
  priceMinor?: number;
  minimumMinor?: number;
  relevantViewers?: number;
  audienceMatch?: number;
  // auction_started / auction_update
  minNextMinor?: number;
  youLead?: boolean;
  bidsLeft?: number;
  // negotiation_counter
  sellerMinor?: number;
  yourLastOfferMinor?: number | null;
  roundsLeft?: number;
  // flash_won
  holdId?: string;
  amountMinor?: number;
  purchaseUrl?: string;
  links?: { reply?: string; bid?: string };
};

/** Our own deployment's HTTP origin (the agent only ever calls it). */
export function agentSiteUrl(): string {
  return (process.env.CONVEX_SITE_URL ?? "https://billboardos.invalid").replace(/\/$/, "");
}
