/**
 * Extra screen-price stages (ADR 0003). Pure functions; callers load inputs.
 * Each returns a PricingStage with a plain-language explanation.
 */
import type { PricingStage } from "./pricing";

const MINUTE = 60_000;

function x(n: number): string {
  return `x${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Event uplift (x1.0 - x1.5)
// ---------------------------------------------------------------------------

export const EVENT_UPLIFT_MAX = 1.5;
/** Events affect slots from 30 min before they start until 30 min after they end. */
export const EVENT_MARGIN_MS = 30 * MINUTE;

export type EventInput = {
  name: string;
  startsAt: number;
  endsAt: number;
  upliftMultiplier: number;
  confidence: number;
  expectedAttendance?: number;
};

/**
 * Strongest nearby event wins. Uplift and confidence are clamped; the
 * explanation names the event. Hook: Claude may later set upliftMultiplier
 * and audienceTags on the event row (source "claude"); this stage still clamps.
 */
export function eventStage(slotStartAt: number, events: EventInput[]): PricingStage {
  const active = events.filter(
    (e) => slotStartAt >= e.startsAt - EVENT_MARGIN_MS && slotStartAt < e.endsAt + EVENT_MARGIN_MS,
  );
  if (active.length === 0) {
    return { key: "event", multiplier: 1, confidence: 1, explanation: "No nearby event at this time" };
  }
  const best = active
    .map((e) => ({
      e,
      uplift: Math.min(EVENT_UPLIFT_MAX, Math.max(1, Number.isFinite(e.upliftMultiplier) ? e.upliftMultiplier : 1)),
      confidence: Math.min(1, Math.max(0, Number.isFinite(e.confidence) ? e.confidence : 0)),
    }))
    .sort((a, b) => b.uplift * b.confidence - a.uplift * a.confidence)[0];
  const crowd = best.e.expectedAttendance ? ` (~${best.e.expectedAttendance.toLocaleString("en-US")} expected)` : "";
  return {
    key: "event",
    multiplier: best.uplift,
    confidence: best.confidence,
    explanation: `${best.e.name}${crowd} is on nearby: event uplift ${x(best.uplift)} at confidence ${best.confidence.toFixed(2)}`,
  };
}

// ---------------------------------------------------------------------------
// Scarcity (x0.85 - x1.5)
// ---------------------------------------------------------------------------

export const SCARCITY_MIN = 0.85;
export const SCARCITY_MAX = 1.5;
export const NEIGHBOR_WINDOW_MS = 2 * 60 * MINUTE;
export const LAST_MINUTE_MS = 60 * MINUTE;
const SOLD_STATES = new Set(["held", "booked", "scheduled", "played", "failed_delivery"]);

export type ScarcityInput = {
  slotStartAt: number;
  now: number;
  /** Other slots on the same screen within +-2h (state only). */
  neighbors: { startAt: number; state: string }[];
  /** Distinct OTHER buyers currently quoting / holding / watching this slot. */
  liveInterest: number;
  /** True if the slot is still unsold. */
  available: boolean;
};

/**
 * Surge with nearby utilization and live interest; last-minute decay for an
 * unsold slot nobody else wants, starting 60 min before it airs.
 */
export function scarcityStage(input: ScarcityInput): PricingStage {
  const total = input.neighbors.length;
  const sold = input.neighbors.filter((n) => SOLD_STATES.has(n.state)).length;
  const utilization = total > 0 ? sold / total : 0;
  const interest = Math.max(0, Math.min(3, Math.floor(input.liveInterest)));
  const surge = 1 + 0.4 * utilization + 0.1 * interest;

  const minutesToStart = (input.slotStartAt - input.now) / MINUTE;
  const lastMinute =
    input.available && interest === 0 && minutesToStart < LAST_MINUTE_MS / MINUTE && utilization < 0.5;
  const decay = lastMinute ? 0.85 + 0.15 * (Math.max(0, minutesToStart) / (LAST_MINUTE_MS / MINUTE)) : 1;
  const multiplier = Math.min(SCARCITY_MAX, Math.max(SCARCITY_MIN, surge * decay));

  const parts: string[] = [];
  parts.push(
    total > 0
      ? `${sold} of ${total} nearby slots (within 2 hours) are sold or held`
      : "No nearby slots to compare",
  );
  if (interest > 0) {
    parts.push(`${interest} other buyer${interest === 1 ? " is" : "s are"} looking at this slot right now`);
  }
  if (lastMinute) {
    parts.push(`unsold and starting in ${Math.max(0, Math.round(minutesToStart))} min, so it gets cheaper as it approaches`);
  }
  return {
    key: "scarcity",
    multiplier: Math.round(multiplier * 100) / 100,
    confidence: 1,
    explanation: `${parts.join("; ")}: ${x(multiplier)}`,
  };
}

// ---------------------------------------------------------------------------
// Market history anchor (x0.9 - x1.2)
// ---------------------------------------------------------------------------

export const MARKET_MIN = 0.9;
export const MARKET_MAX = 1.2;
export const MARKET_LOOKBACK_MS = 14 * 24 * 60 * MINUTE;
/** Confidence reaches 1 at this many comparable sales. */
export const MARKET_FULL_CONFIDENCE_SALES = 5;

/**
 * Anchor on what this screen actually sold for in the same hour band
 * recently, relative to the time-adjusted base rate.
 */
export function marketStage(band: string, sales: { normalizedRatio: number }[]): PricingStage {
  const valid = sales.filter((s) => Number.isFinite(s.normalizedRatio) && s.normalizedRatio > 0);
  if (valid.length === 0) {
    return {
      key: "market",
      multiplier: 1,
      confidence: 0,
      explanation: `No recent sales in the ${band} band yet`,
    };
  }
  const mean = valid.reduce((s, v) => s + v.normalizedRatio, 0) / valid.length;
  const multiplier = Math.min(MARKET_MAX, Math.max(MARKET_MIN, mean));
  const confidence = Math.min(1, valid.length / MARKET_FULL_CONFIDENCE_SALES);
  return {
    key: "market",
    multiplier: Math.round(multiplier * 100) / 100,
    confidence,
    explanation: `${valid.length} recent sale${valid.length === 1 ? "" : "s"} in the ${band} band averaged ${x(mean)} the time-adjusted base: anchor ${x(multiplier)} (confidence ${confidence.toFixed(2)})`,
  };
}
