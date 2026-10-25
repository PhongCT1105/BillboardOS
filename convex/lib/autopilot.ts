/**
 * Host autopilot rules (ADR 0007 §1). Pure helpers, integer cents.
 *
 * Time until the slot decides what the seller agent does:
 *   < 15 min   "live":   left to the live auction (already built)
 *   15 min-2 h "ahead":  forward offer at the forecast price, decaying toward
 *                        the floor as the slot nears unsold (never below it)
 *   2-12 h     "early":  early-booking price, modestly below the forecast
 *                        price, raised as the forecast or demand rises
 *   > 12 h     "beyond": not planned yet
 *
 * Value is the live auction's formula (lib/livePrice): expected people in
 * view x plays in the spot / 1000 x reference CPM x relevance.
 */
import { livePrice } from "./livePrice";
import { matchScore, type AudienceTags } from "./match";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const LIVE_HANDOFF_MS = 15 * MINUTE;
export const AHEAD_UNTIL_MS = 2 * HOUR;
export const HORIZON_MS = 12 * HOUR;
/** A forward sale at a fixed price: three quarters of the forecast value. */
export const FORWARD_SHARE = 0.75;
/** Early booking: 10% under the forecast price. */
export const EARLY_SHARE = 0.9;
/** Each extra interested company raises the early price 5%, up to 15%. */
export const DEMAND_STEP = 0.05;
export const DEMAND_MAX = 1.15;
/** At the live hand-off the ahead price has decayed to the floor + 30% of the gap. */
export const DECAY_MIN = 0.3;
/** With two or more companies offered, yeses are collected this long before deciding. */
export const FIRST_LOOK_MS = 15_000;
/** A scheduled auction (2 min + 3 min soft-close cap + 6 min pay margin) needs this lead time. */
export const AUCTION_LEAD_MS = 12 * MINUTE;
/** Re-notify companies when the price moves at least this much. */
export const RENOTIFY_SHARE = 0.1;
export const RENOTIFY_MIN_MINOR = 5;

export type Band = "live" | "ahead" | "early" | "beyond";

export function bandOf(msUntilStart: number): Band {
  if (msUntilStart < LIVE_HANDOFF_MS) return "live";
  if (msUntilStart < AHEAD_UNTIL_MS) return "ahead";
  if (msUntilStart <= HORIZON_MS) return "early";
  return "beyond";
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** What the slot is worth, by the live auction's formula, with the forecast instead of the live count. */
export function forwardValue(i: { expectedPeople: number; slotMs: number; cpmRefMinor: number; bestMatch: number; floorMinor: number }) {
  const p = livePrice({
    peopleInView: Math.max(0, i.expectedPeople),
    spotMs: i.slotMs,
    cpmRefMinor: i.cpmRefMinor,
    bestMatch: clamp(i.bestMatch, 0, 1),
    idleMs: 0,
    msUntilStart: HORIZON_MS,
    reofferRound: 0,
    minimumMinor: i.floorMinor,
    jitter: 0,
  });
  return { valueMinor: p.valueMinor, plays: p.plays, relevance: p.relevance };
}

/**
 * The price for a slot in its band. Never below the floor. "ahead" decays
 * linearly from the forecast price (2 h out) to floor + 30% of the gap (15 min
 * out); "early" is 90% of the forecast price, up to 15% more with demand.
 */
export function forwardPrice(i: {
  band: Band;
  valueMinor: number;
  floorMinor: number;
  msUntilStart: number;
  interested: number;
}): { priceMinor: number; rule: string } {
  const floor = Math.max(1, Math.round(i.floorMinor));
  const forecastPrice = Math.max(floor, Math.round(i.valueMinor * FORWARD_SHARE));
  if (i.band === "early") {
    const demand = Math.min(DEMAND_MAX, 1 + DEMAND_STEP * Math.max(0, i.interested - 1));
    const priceMinor = Math.max(floor, Math.round(forecastPrice * EARLY_SHARE * demand));
    return {
      priceMinor,
      rule: `early-booking price ${Math.round(EARLY_SHARE * 100)}% of the forecast price${demand > 1 ? ` ×${demand.toFixed(2)} for ${i.interested} interested companies` : ""}`,
    };
  }
  // "ahead" (and an owner's sell-now inside the live window: fully decayed).
  const frac = clamp((i.msUntilStart - LIVE_HANDOFF_MS) / (AHEAD_UNTIL_MS - LIVE_HANDOFF_MS), 0, 1);
  const keep = DECAY_MIN + (1 - DECAY_MIN) * frac;
  const priceMinor = Math.max(floor, floor + Math.round((forecastPrice - floor) * keep));
  return {
    priceMinor,
    rule: keep < 1 ? `forecast price decayed to ${Math.round(keep * 100)}% of the way above the floor as the slot nears` : "forecast price",
  };
}

/** Re-send the offer when the price moved by at least 10% (5 cents minimum). */
export function shouldRenotify(notifiedPriceMinor: number | undefined, priceMinor: number): boolean {
  if (notifiedPriceMinor === undefined) return true;
  return Math.abs(priceMinor - notifiedPriceMinor) >= Math.max(RENOTIFY_MIN_MINOR, Math.round(notifiedPriceMinor * RENOTIFY_SHARE));
}

/** Contention is possible: two or more companies were offered a slot that can still be auctioned. */
export function firstLookApplies(i: { targets: number; msUntilStart: number }): boolean {
  return i.targets >= 2 && i.msUntilStart >= AUCTION_LEAD_MS + FIRST_LOOK_MS;
}

/** After the first look: nobody (stays open), one company (it gets the hold) or two or more (auction). */
export function decideInterest(distinctCompanies: number): "keep_open" | "hold" | "auction" {
  if (distinctCompanies <= 0) return "keep_open";
  if (distinctCompanies === 1) return "hold";
  return "auction";
}

export type CompanyLimits = {
  advertiserId: string;
  company: string;
  targetAudience?: AudienceTags;
  minRelevantViewers: number;
  maxPerSpotMinor: number;
  budgetLeftMinor: number;
};

export type CompanyFit = { matchScore: number; relevantViewers: number; fits: boolean; why: string | null };

/** Does a company's profile and reach target fit the forecast crowd (price aside)? */
export function companyFit(mix: AudienceTags, expectedPeople: number, minMatch: number, c: CompanyLimits): CompanyFit {
  const m = matchScore(mix, c.targetAudience) ?? 0;
  const relevantViewers = Math.round(expectedPeople * m);
  if (m < minMatch) return { matchScore: m, relevantViewers, fits: false, why: `audience match ${Math.round(m * 100)}% is under ${Math.round(minMatch * 100)}%` };
  if (relevantViewers < c.minRelevantViewers) {
    return { matchScore: m, relevantViewers, fits: false, why: `${relevantViewers} matching people forecast, under its reach target of ${c.minRelevantViewers}` };
  }
  return { matchScore: m, relevantViewers, fits: true, why: null };
}

/** Within the company's own limits at this price? */
export function withinLimits(c: CompanyLimits, priceMinor: number): string | null {
  if (priceMinor > c.maxPerSpotMinor) return `price is over its max of ${usd(c.maxPerSpotMinor)} per spot`;
  if (priceMinor > c.budgetLeftMinor) return "its daily budget is used up";
  return null;
}

export const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

/** "5:00 PM" in the screen's local time. */
export function clockLabel(ms: number, utcOffsetMinutes: number): string {
  const d = new Date(ms + utcOffsetMinutes * MINUTE);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

/** "5:00–5:15 PM". */
export function slotLabel(startAt: number, endAt: number, utcOffsetMinutes: number): string {
  const a = clockLabel(startAt, utcOffsetMinutes);
  const b = clockLabel(endAt, utcOffsetMinutes);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

/** "45 min" or "3 h 15 min". */
export function leadLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "Nvidia", "Nvidia and LaunchKit", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
