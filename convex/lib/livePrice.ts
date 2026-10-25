/**
 * Live pricing rules for the host pricing agent. Pure helpers, integer cents.
 *
 * value  = people in view x plays x reference CPM x relevance
 * opening = 60% of value, discounted for idle time and imminent start
 * (both paused for a large crowd), stepped down on re-offers, floored at
 * the host's minimum and never above the value.
 */

export const AD_SECONDS = 30;
export const DEFAULT_CPM_MINOR = 500;
export const DEFAULT_LIVE_MINIMUM_MINOR = 25;
export const OPENING_SHARE = 0.6;
export const IDLE_STEP = 0.9;
export const MAX_IDLE_PERIODS = 5;
export const LARGE_CROWD = 25;
export const START_DISCOUNT = 0.1;
export const REOFFER_STEP = 0.85;
export const MAX_JITTER = 0.03;
export const MIN_SALES_FOR_REF = 5;

const PERIOD_MS = 15 * 60_000;

export type LivePriceInput = {
  peopleInView: number;
  spotMs: number;
  cpmRefMinor: number;
  bestMatch: number;
  idleMs: number;
  msUntilStart: number;
  reofferRound: number;
  minimumMinor: number;
  jitter: number;
};

export type LivePrice = {
  valueMinor: number;
  openingMinor: number;
  minimumMinor: number;
  plays: number;
  impressions: number;
  relevance: number;
  why: string;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const usd = (m: number) => `$${(m / 100).toFixed(2)}`;

/** Value of the spot and the price bidding opens at, with a plain-English reason. */
export function livePrice(i: LivePriceInput): LivePrice {
  const plays = Math.max(1, Math.floor(i.spotMs / (AD_SECONDS * 1000)));
  const impressions = i.peopleInView * plays;
  // Round away float noise (0.7 + 0.8 x 0.375 is 1.0000000000000002).
  const relevance = Math.round(clamp(0.7 + 0.8 * i.bestMatch, 0.7, 1.5) * 1e9) / 1e9;
  const valueMinor = Math.round(((impressions * i.cpmRefMinor) / 1000) * relevance);

  const large = i.peopleInView >= LARGE_CROWD;
  const idleFactor = large ? 1 : IDLE_STEP ** Math.min(MAX_IDLE_PERIODS, Math.floor(i.idleMs / PERIOD_MS));
  const startFactor = large ? 1 : 1 - START_DISCOUNT * (1 - Math.min(1, i.msUntilStart / PERIOD_MS));
  const raw = Math.round(
    valueMinor * OPENING_SHARE * idleFactor * startFactor * REOFFER_STEP ** i.reofferRound * (1 + clamp(i.jitter, -MAX_JITTER, MAX_JITTER)),
  );
  const openingMinor =
    valueMinor <= i.minimumMinor ? i.minimumMinor : Math.max(i.minimumMinor, Math.min(valueMinor, raw));

  const idleMin = Math.floor(i.idleMs / 60_000);
  let why = `${i.peopleInView} people × ${plays} plays at ${usd(i.cpmRefMinor)} per 1,000 views × ${relevance.toFixed(2)} fit ≈ ${usd(valueMinor)}; idle ${idleMin} min; bidding opens at ${usd(openingMinor)} (minimum ${usd(i.minimumMinor)})`;
  if (i.reofferRound > 0) why += `; re-offer ${i.reofferRound}`;

  return { valueMinor, openingMinor, minimumMinor: i.minimumMinor, plays, impressions, relevance, why };
}

/** Reference CPM: median implied CPM of the last 20 sales (oldest first), else the starting rate. */
export function referenceCpm(sales: { amountMinor: number; impressions: number }[], startingCpmMinor: number): number {
  const cpms = sales
    .filter((s) => s.impressions > 0)
    .slice(-20)
    .map((s) => Math.round((s.amountMinor * 1000) / s.impressions));
  if (cpms.length < MIN_SALES_FOR_REF) return startingCpmMinor;
  const sorted = [...cpms].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
