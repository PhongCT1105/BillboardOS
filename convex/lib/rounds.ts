/**
 * Rounds: pure rules, integer cents, no Convex calls (rounds.ts runs them).
 * Every round sells the next 30-second window on one screen while the
 * current window plays. Each invited company gets its own price, has two
 * turns (answer, then answer the host's one counter), and when the 30
 * seconds are up the highest agreed price wins.
 *
 *   price = a x predicted price + b x people in view + c x brand value
 *
 * clamped to [floor, cap], where cap = capMultiplier x the predicted price
 * (never below the floor), so a busy crowd or a big brand can't run away.
 */

/** One sale = one 30-second window on screen; its bidding runs during the window before. */
export const WINDOW_MS = 30_000;
export const MAX_INVITES = 20;
/** A company is offered the window when its buyers make up at least this share of the crowd. */
export const MIN_MATCH = 0.2;
/** A people count older than this isn't "in view now". */
export const PEOPLE_FRESH_MS = 60_000;

/** The host's knobs for one screen (cents per person, cents per brand point). */
export type PriceWeights = { a: number; b: number; c: number; capMultiplier: number };
export const DEFAULT_WEIGHTS: PriceWeights = { a: 1, b: 0.5, c: 3, capMultiplier: 2 };

export function validateWeights(w: PriceWeights): string | null {
  for (const [k, v, lo, hi] of [["a", w.a, 0, 5], ["b", w.b, 0, 100], ["c", w.c, 0, 1000], ["capMultiplier", w.capMultiplier, 1, 10]] as const) {
    if (!Number.isFinite(v) || v < lo || v > hi) return `${k} must be between ${lo} and ${hi}`;
  }
  return null;
}

/** Brand value 0..1 from the research agent's price factor (x0.8 small and price-sensitive .. x1.5 big brand). */
export function brandScore(priceFactor: number): number {
  return Math.round(Math.min(1, Math.max(0, (priceFactor - 0.8) / 0.7)) * 100) / 100;
}

export type PriceTerms = { modelMinor: number; peopleMinor: number; brandMinor: number; capMinor: number; capped: "floor" | "cap" | null };

/** One company's price for the window. */
export function windowPrice(i: { predictedMinor: number; people: number | null; brand: number; floorMinor: number; w: PriceWeights }): { priceMinor: number; terms: PriceTerms } {
  const modelMinor = i.w.a * i.predictedMinor;
  const peopleMinor = i.w.b * (i.people ?? 0);
  const brandMinor = i.w.c * i.brand;
  const capMinor = Math.max(i.floorMinor, Math.round(i.w.capMultiplier * Math.max(i.predictedMinor, i.floorMinor)));
  const raw = Math.round(modelMinor + peopleMinor + brandMinor);
  const priceMinor = Math.min(capMinor, Math.max(i.floorMinor, raw));
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    priceMinor,
    terms: { modelMinor: r(modelMinor), peopleMinor: r(peopleMinor), brandMinor: r(brandMinor), capMinor, capped: raw < i.floorMinor ? "floor" : raw > capMinor ? "cap" : null },
  };
}

export type Agreed = { id: string; amountMinor: number; agreedAt: number };

/** When the window's bidding ends: the highest agreed price wins (ties: who agreed first). Null: nobody agreed. */
export function bestAgreed(agreed: Agreed[]): Agreed | null {
  return [...agreed].sort((x, y) => y.amountMinor - x.amountMinor || x.agreedAt - y.agreedAt)[0] ?? null;
}

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

/** What an agent sees when it answers: the host's price to it now, the floor, and its own limits. */
export type OfferContext = {
  floorMinor: number;
  priceMinor: number;
  maxPerSpotMinor: number;
  budgetLeftMinor: number;
  balanceMinor: number | null;
};
/** An agent's answer: `amountMinor` at or above the price accepts, below it counters, null passes. */
export type OfferAnswer = { amountMinor: number | null; reasoning: string };
/** How an agent answers an offer or a counter. Swap in a Claude strategy later. */
export type OfferStrategy = (c: OfferContext) => OfferAnswer;

/** Take the price if it fits every limit; otherwise counter at the most it can pay; pass below the floor. */
export const ruleBasedStrategy: OfferStrategy = (c) => {
  if (c.balanceMinor === null) return { amountMinor: null, reasoning: "Wallet balance not read yet, so I can't commit to a price" };
  const limits: [number, string][] = [
    [c.maxPerSpotMinor, `my ${usd(c.maxPerSpotMinor)} per-spot limit`],
    [Math.max(0, c.budgetLeftMinor), "my budget left today"],
    [Math.max(0, c.balanceMinor), "my wallet balance"],
  ];
  const [cap, capped] = limits.reduce((lo, l) => (l[0] < lo[0] ? l : lo));
  if (c.priceMinor <= cap) return { amountMinor: c.priceMinor, reasoning: `Accepting ${usd(c.priceMinor)}: within ${capped}` };
  if (cap >= c.floorMinor) return { amountMinor: cap, reasoning: `${usd(c.priceMinor)} is over ${capped}; offering ${usd(cap)}` };
  return { amountMinor: null, reasoning: `Passing: ${capped} (${usd(cap)}) is under the ${usd(c.floorMinor)} floor` };
};

export type HostReply = { kind: "deal"; priceMinor: number } | { kind: "counter"; priceMinor: number };

/**
 * The host's answer to one company's offer (never compared with anyone
 * else's): at or above its price, a deal at its price. Under it, the host
 * counters once, halfway; a second offer at or above the floor is a deal.
 * Offers under the floor are refused before this is called.
 */
export function hostReply(i: { amountMinor: number; priceMinor: number; countered: boolean }): HostReply {
  if (i.amountMinor >= i.priceMinor) return { kind: "deal", priceMinor: i.priceMinor };
  const half = Math.round((i.amountMinor + i.priceMinor) / 2);
  if (i.countered || half >= i.priceMinor) return { kind: "deal", priceMinor: i.amountMinor };
  return { kind: "counter", priceMinor: half };
}

/**
 * Keep an LLM agent's answer inside the rules and its own limits: never more
 * than the host's price (that's agreeing) or the most it can pay; under the
 * floor, or nothing it can pay, is a pass. Whole cents.
 */
export function clampAnswer(i: { amountMinor: number | null; priceMinor: number; floorMinor: number; capMinor: number; reasoning: string }): OfferAnswer {
  if (i.amountMinor === null || !Number.isFinite(i.amountMinor)) return { amountMinor: null, reasoning: i.reasoning };
  const amount = Math.min(Math.round(i.amountMinor), i.priceMinor, i.capMinor);
  if (amount < i.floorMinor) return { amountMinor: null, reasoning: `${i.reasoning} (passing: ${usd(amount)} is under the ${usd(i.floorMinor)} floor)` };
  return { amountMinor: amount, reasoning: i.reasoning };
}
