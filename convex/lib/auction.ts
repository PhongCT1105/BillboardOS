/**
 * Ascending auction with proxy bidding (ADR 0003 section 3). Pure helpers.
 *
 * Every participant has an effective maximum = max(highest manual bid,
 * private auto-bid max), capped by its campaign budget. The leader is the
 * highest effective max (ties: whoever reached it first). The price is the
 * lowest amount that beats everyone else by one increment, never above the
 * leader's max and never below the reserve or the leader's own manual bid:
 *
 *   price = min(leaderMax, max(secondMax + increment(secondMax), leaderManualTop, reserve))
 *
 * This is exactly what a sequence of proxy bids produces, computed in one step.
 */

export const DEFAULT_INCREMENT = { percentBps: 500, minMinor: 100 }; // 5%, at least $1
export const SOFT_CLOSE_MS = 30_000;
export const DEFAULT_DURATION_MS = 2 * 60_000;
export const HARD_CAP_EXTRA_MS = 3 * 60_000;
export const MAX_SLOTS_PER_AUCTION = 4;
export const CONTENTION_WINDOW_MS = 10 * 60_000;
export const CONTENTION_MIN_BUYERS = 2;
export const HOT_CROWD_RATIO = 1.5;

export type IncrementRule = { percentBps: number; minMinor: number };

/** Minimum raise over `amount`: 5% rounded up to the cent, at least $1. */
export function increment(amount: number, rule: IncrementRule = DEFAULT_INCREMENT): number {
  return Math.max(rule.minMinor, Math.ceil((amount * rule.percentBps) / 10_000));
}

/** Lowest acceptable next bid. */
export function minNextBid(state: { hasLeader: boolean; currentMinor: number; reserveMinor: number }, rule?: IncrementRule): number {
  return state.hasLeader ? state.currentMinor + increment(state.currentMinor, rule) : state.reserveMinor;
}

export type ProxyParticipant<P extends string> = {
  id: P;
  effectiveMaxMinor: number;
  manualTopMinor: number;
  maxSetAt: number;
};

export type Resolution<P extends string> = {
  leaderId: P | null;
  priceMinor: number;
  secondId: P | null;
  secondMaxMinor: number;
};

/** Leader and price from everyone's effective maximum (see header). */
export function resolveProxy<P extends string>(
  participants: ProxyParticipant<P>[],
  reserveMinor: number,
  rule?: IncrementRule,
): Resolution<P> {
  const eligible = participants
    .filter((p) => p.effectiveMaxMinor >= reserveMinor)
    .sort((a, b) => b.effectiveMaxMinor - a.effectiveMaxMinor || a.maxSetAt - b.maxSetAt || a.id.localeCompare(b.id));
  if (eligible.length === 0) {
    return { leaderId: null, priceMinor: reserveMinor, secondId: null, secondMaxMinor: 0 };
  }
  const leader = eligible[0];
  const second = eligible[1];
  if (!second) {
    return {
      leaderId: leader.id,
      priceMinor: Math.max(reserveMinor, Math.min(leader.effectiveMaxMinor, leader.manualTopMinor || reserveMinor)),
      secondId: null,
      secondMaxMinor: 0,
    };
  }
  const beat = second.effectiveMaxMinor + increment(second.effectiveMaxMinor, rule);
  const price = Math.min(leader.effectiveMaxMinor, Math.max(beat, leader.manualTopMinor, reserveMinor));
  return { leaderId: leader.id, priceMinor: price, secondId: second.id, secondMaxMinor: second.effectiveMaxMinor };
}

/** Soft close: a bid in the last 30 s pushes the end out to now + 30 s, never past the hard cap. */
export function extendForSoftClose(
  now: number,
  endsAt: number,
  hardEndsAt: number,
  softCloseMs: number = SOFT_CLOSE_MS,
): number {
  if (endsAt - now > softCloseMs) return endsAt;
  return Math.min(hardEndsAt, Math.max(endsAt, now + softCloseMs));
}

/**
 * ADR hot-slot rule: two or more distinct buyers quoting or holding within
 * 10 minutes; or trailing crowd at least 1.5x normal; or an event uplift.
 */
export function hotReasons(input: {
  distinctBuyers: number;
  crowdRatio: number | null;
  eventUplift: number;
}): string[] {
  const reasons: string[] = [];
  if (input.distinctBuyers >= CONTENTION_MIN_BUYERS) {
    reasons.push(`${input.distinctBuyers} buyers are competing for this slot within 10 minutes`);
  }
  if (input.crowdRatio !== null && input.crowdRatio >= HOT_CROWD_RATIO) {
    reasons.push(`crowd is ${input.crowdRatio.toFixed(2)}x normal traffic`);
  }
  if (input.eventUplift > 1) {
    reasons.push(`an event nearby lifts demand x${input.eventUplift.toFixed(2)}`);
  }
  return reasons;
}

/** Hex SHA-256 of a bidder key (Web Crypto; no Node needed). */
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "Bidder A", "Bidder B", ..., "Bidder Z", "Bidder 27", ... */
export function bidderLabel(index: number): string {
  return index < 26 ? `Bidder ${String.fromCharCode(65 + index)}` : `Bidder ${index + 1}`;
}
