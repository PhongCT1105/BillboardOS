/**
 * Rounds (the spot on air now): pure rules, integer cents, no Convex calls.
 * The host offers every company the same price (floor x signals); each
 * company deals with the host alone (accept, counter, pass); the first deal
 * takes the spot (rounds.ts), then pay -> play.
 *
 * Signals only move the price; the floor is the least the host takes. A
 * missing signal is listed with its reason and never blocks a sale.
 */

export const ROUND_CLOSE_MS = 10_000;
export const CAMERA_COOLDOWN_MS = 60_000;
export const AUTO_SELL_GAP_MS = 120_000;
export const MAX_INVITES = 20;
export const DEFAULT_USUAL_IN_VIEW = 3;
export const CROWD_MAX = 3;
export const EVENT_FACTOR = 1.2;

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export type PriceSignal = { key: "crowd" | "event" | "demand"; factor: number | null; reason: string };

/** Each paid sale on this screen in the last 2 hours adds this much, up to DEMAND_MAX. */
export const DEMAND_STEP = 0.1;
export const DEMAND_MAX = 1.5;
/** A company is offered the spot when its buyers make up at least this share of the crowd. */
export const MIN_MATCH = 0.2;

/** Every signal, in a fixed order; `factor: null` when its data is missing (said in `reason`). */
export function priceSignals(i: { peakInView: number | null; usualInView: number | undefined; eventName: string | null; recentSales: number }): PriceSignal[] {
  const usual = i.usualInView && i.usualInView > 0 ? i.usualInView : DEFAULT_USUAL_IN_VIEW;
  const crowd: PriceSignal =
    i.peakInView === null
      ? { key: "crowd", factor: null, reason: "No camera reading: crowd not counted" }
      : (() => {
          const factor = Math.round(clamp(i.peakInView / usual, 1, CROWD_MAX) * 100) / 100;
          return { key: "crowd", factor, reason: `${i.peakInView} in view, usually ${usual}: ×${factor.toFixed(2)}` };
        })();
  const event: PriceSignal = i.eventName
    ? { key: "event", factor: EVENT_FACTOR, reason: `${i.eventName} on now: ×${EVENT_FACTOR.toFixed(2)}` }
    : { key: "event", factor: null, reason: "No event" };
  const demandFactor = Math.round(Math.min(DEMAND_MAX, 1 + DEMAND_STEP * i.recentSales) * 100) / 100;
  const demand: PriceSignal =
    i.recentSales > 0
      ? { key: "demand", factor: demandFactor, reason: `${i.recentSales} sold here in the last 2 h: ×${demandFactor.toFixed(2)}` }
      : { key: "demand", factor: null, reason: "No sales here in the last 2 h" };
  return [crowd, event, demand];
}

/** One company's offer: the round's price × the company's research factor, never under the floor. */
export function companyOffer(askingMinor: number, floorMinor: number, companyFactor: number): number {
  return Math.max(floorMinor, Math.round(askingMinor * companyFactor));
}

/** Floor × every known factor. */
export function askingPrice(floorMinor: number, signals: PriceSignal[]): number {
  return Math.round(signals.reduce((p, s) => (s.factor === null ? p : p * s.factor), floorMinor));
}

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
