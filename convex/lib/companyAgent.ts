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

/** Reaction to a spot announcement: accept the opening price, counter lower, or pass. */
export function onAnnounce(i: {
  openingMinor: number;
  minimumMinor: number;
  relevantViewers: number;
  minRelevantViewers: number;
  cap: number;
}): AgentDecision {
  if (i.relevantViewers < i.minRelevantViewers) {
    return { decision: "pass", reasoning: `Only ${i.relevantViewers} relevant viewers, under my minimum of ${i.minRelevantViewers}` };
  }
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
export function onCounter(i: { sellerMinor: number; lastOfferMinor: number; cap: number }): AgentDecision {
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
