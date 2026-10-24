/**
 * Seller agent negotiation policy (ADR 0005 §2). Pure and deterministic:
 * code decides every number; reasoning text explains it. A Claude "narrate"
 * hook may later rewrite the prose (see `Narrator`), never the amounts.
 */

export type NegotiationPolicy = {
  /** Never agree below screen price x this ratio. */
  floorRatio: number;
  /** Buyer offers allowed (the last one is final: accept or reject). */
  maxRounds: number;
  /** How long each seller position is valid. */
  offerTtlMs: number;
};

export const DEFAULT_POLICY: NegotiationPolicy = { floorRatio: 0.9, maxRounds: 4, offerTtlMs: 2 * 60_000 };

export const POLICY_LIMITS = {
  floorRatio: { min: 0.5, max: 1 },
  maxRounds: { min: 1, max: 10 },
  offerTtlMs: { min: 30_000, max: 30 * 60_000 },
} as const;

/** Slots per negotiation (same as a small quote). */
export const MAX_NEGOTIATION_SLOTS = 4;

/** Share of the remaining gap the seller gives up in round 1, 2, 3, ...: shrinking concessions. */
export const CONCESSION_SCHEDULE = [0.35, 0.25, 0.15, 0.1, 0.06, 0.04, 0.03, 0.02, 0.01, 0.01];

export function policyOf(ws: {
  negotiationFloorRatio?: number;
  negotiationMaxRounds?: number;
  negotiationOfferTtlMs?: number;
}): NegotiationPolicy {
  return {
    floorRatio: ws.negotiationFloorRatio ?? DEFAULT_POLICY.floorRatio,
    maxRounds: ws.negotiationMaxRounds ?? DEFAULT_POLICY.maxRounds,
    offerTtlMs: ws.negotiationOfferTtlMs ?? DEFAULT_POLICY.offerTtlMs,
  };
}

/** Policy problems, or null when valid. */
export function validatePolicy(p: NegotiationPolicy): string | null {
  const L = POLICY_LIMITS;
  if (!Number.isFinite(p.floorRatio) || p.floorRatio < L.floorRatio.min || p.floorRatio > L.floorRatio.max) {
    return `Floor ratio must be between ${L.floorRatio.min} and ${L.floorRatio.max}`;
  }
  if (!Number.isInteger(p.maxRounds) || p.maxRounds < L.maxRounds.min || p.maxRounds > L.maxRounds.max) {
    return `Max rounds must be a whole number ${L.maxRounds.min}..${L.maxRounds.max}`;
  }
  if (!Number.isInteger(p.offerTtlMs) || p.offerTtlMs < L.offerTtlMs.min || p.offerTtlMs > L.offerTtlMs.max) {
    return "Offer validity must be between 30 seconds and 30 minutes";
  }
  return null;
}

/** The lowest total the seller accepts: max(screen x ratio, reserve floor x slots). */
export function negotiationFloor(screenMinor: number, reserveFloorMinor: number, slotCount: number, floorRatio: number): number {
  return Math.max(Math.ceil(screenMinor * floorRatio), reserveFloorMinor * slotCount);
}

/** Opening ask: the company's posted price (multiplier folded in), never below the floor. */
export function openingAsk(postedMinor: number, floorMinor: number): number {
  return Math.max(postedMinor, floorMinor);
}

export const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

export type SellerState = {
  floorMinor: number;
  /** Seller's current position (last ask or counter). */
  sellerMinor: number;
  /** Highest buyer offer before this one (null if none). */
  bestBuyerMinor: number | null;
  /** 1-based number of THIS buyer offer. */
  round: number;
  maxRounds: number;
};

export type SellerDecision =
  | { kind: "accept"; amountMinor: number; reasoning: string }
  | { kind: "counter"; amountMinor: number; reasoning: string }
  | { kind: "reject"; reasoning: string };

/**
 * Respond to a buyer offer. Guarantees: never accepts or counters below the
 * floor; counters never go up; each concession is no bigger than the last
 * (shrinking schedule over a gap that only narrows); the final round is
 * accept-or-reject.
 */
export function sellerRespond(state: SellerState, offerMinor: number): SellerDecision {
  const { floorMinor, sellerMinor, round, maxRounds } = state;
  const left = maxRounds - round;
  if (offerMinor >= sellerMinor) {
    return {
      kind: "accept",
      amountMinor: sellerMinor,
      reasoning: `Your offer of ${usd(offerMinor)} meets our price. Agreed at ${usd(sellerMinor)}.`,
    };
  }
  if (left <= 0) {
    if (offerMinor >= floorMinor) {
      return {
        kind: "accept",
        amountMinor: offerMinor,
        reasoning: `Final round: ${usd(offerMinor)} is within our policy. Agreed.`,
      };
    }
    return {
      kind: "reject",
      reasoning: `Final round: ${usd(offerMinor)} is below what this screen sells for under our policy. No deal this time; posted quotes stay open.`,
    };
  }
  const best = Math.max(offerMinor, state.bestBuyerMinor ?? 0);
  const target = Math.max(best, floorMinor);
  const fraction = CONCESSION_SCHEDULE[Math.min(round - 1, CONCESSION_SCHEDULE.length - 1)];
  const concession = Math.max(0, Math.round((sellerMinor - target) * fraction));
  const counter = Math.max(floorMinor, sellerMinor - concession);
  if (counter <= offerMinor) {
    return {
      kind: "accept",
      amountMinor: offerMinor,
      reasoning: `${usd(offerMinor)} is close enough to our position. Agreed.`,
    };
  }
  const roundsText = `${left} round${left === 1 ? "" : "s"} left`;
  const reasoning =
    concession === 0
      ? `${usd(sellerMinor)} is our best price for these slots; we can't go lower. ${roundsText}.`
      : `We can move ${usd(concession)} to ${usd(counter)} (from ${usd(sellerMinor)}); your ${usd(offerMinor)} is under what this audience is worth right now. ${roundsText}.`;
  return { kind: "counter", amountMinor: counter, reasoning };
}

/**
 * Narrate hook (ADR 0005 §2: "Claude writes the reasoning text"). A future
 * action can implement this with Claude and store the result in
 * `negotiationMessages.narration`; it receives the deterministic decision and
 * must not change any number. Today the deterministic text is used as-is.
 */
export type Narrator = (message: {
  from: "buyer" | "seller" | "system";
  kind: string;
  amountMinor?: number;
  reasoning: string;
}) => Promise<string>;

export const identityNarrator: Narrator = async (m) => m.reasoning;
