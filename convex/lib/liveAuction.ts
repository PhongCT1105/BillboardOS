/**
 * Live auction rules (the short, in-the-moment auction). Pure helpers,
 * integer cents. Bids go up in 5% steps (at least 5 cents); a bid in the
 * last 3 s extends the close by 3 s, at most twice.
 */
import { increment, type IncrementRule } from "./auction";

export const LIVE_INCREMENT: IncrementRule = { percentBps: 500, minMinor: 5 };
export const JOIN_WINDOW_MS = 2_000;
export const BIDDING_MS = 12_000;
export const EXTENSION_MS = 3_000;
export const MAX_EXTENSIONS = 2;
export const MAX_BIDS_PER_COMPANY = 5;
export const REOFFER_DELAY_MS = 20_000;
export const NEXT_SPOT_LEAD_MS = 60_000;
export const NEGOTIATION_MAX_ROUNDS = 4;
export const NEGOTIATION_TIME_CAP_MS = 18_000;

/** Lowest acceptable next bid: the opening price, or the leader plus one step. */
export function minNextLiveBid(s: { leaderMinor: number | null; openingMinor: number }): number {
  return s.leaderMinor === null ? s.openingMinor : s.leaderMinor + increment(s.leaderMinor, LIVE_INCREMENT);
}

/** Anti-sniping: a bid with 3 s or less left adds 3 s to the close, up to two times. */
export function extendLive(s: { now: number; closesAt: number; extensions: number }): { closesAt: number; extensions: number } {
  if (s.extensions >= MAX_EXTENSIONS || s.closesAt - s.now > EXTENSION_MS) {
    return { closesAt: s.closesAt, extensions: s.extensions };
  }
  return { closesAt: s.closesAt + EXTENSION_MS, extensions: s.extensions + 1 };
}

export type JoinReply = {
  offerId: string;
  status: "accepted" | "countered" | "passed" | "sent" | "expired";
  amountMinor: number | null;
  repliedAt: number | null;
};

export type JoinOutcome =
  | { kind: "auction"; participantIds: string[] }
  | { kind: "sale"; offerId: string; amountMinor: number }
  | { kind: "negotiation"; offerId: string; amountMinor: number }
  | { kind: "none" };

/** What the join window produced: auction (2+ accepted), sale (1), negotiation (best counter) or nothing. */
export function joinOutcome(replies: JoinReply[]): JoinOutcome {
  const accepted = replies.filter((r) => r.status === "accepted");
  const countered = replies.filter((r) => r.status === "countered");
  if (accepted.length >= 2) {
    return { kind: "auction", participantIds: [...accepted, ...countered].map((r) => r.offerId) };
  }
  if (accepted.length === 1) {
    return { kind: "sale", offerId: accepted[0].offerId, amountMinor: accepted[0].amountMinor ?? 0 };
  }
  if (countered.length > 0) {
    const best = [...countered].sort(
      (a, b) => (b.amountMinor ?? 0) - (a.amountMinor ?? 0) || (a.repliedAt ?? Infinity) - (b.repliedAt ?? Infinity),
    )[0];
    return { kind: "negotiation", offerId: best.offerId, amountMinor: best.amountMinor ?? 0 };
  }
  return { kind: "none" };
}

export type BidError = "NOT_BIDDING" | "BIDDING_CLOSED" | "BID_LIMIT" | "ALREADY_LEADING" | "BID_TOO_LOW";

/** First rule a bid breaks, or null if it is valid. */
export function checkBid(s: {
  phase: string;
  now: number;
  closesAt: number;
  bidCount: number;
  isLeader: boolean;
  amountMinor: number;
  minNextMinor: number;
}): BidError | null {
  if (s.phase !== "bidding") return "NOT_BIDDING";
  if (s.now >= s.closesAt) return "BIDDING_CLOSED";
  if (s.bidCount >= MAX_BIDS_PER_COMPANY) return "BID_LIMIT";
  if (s.isLeader) return "ALREADY_LEADING";
  if (s.amountMinor < s.minNextMinor) return "BID_TOO_LOW";
  return null;
}

/** Grace past each phase's own close before a live moment counts as stuck (its scheduled close never ran). */
export const STUCK_GRACE = { offeringMs: 10_000, biddingMs: 30_000, negotiatingMs: 30_000, awardedMs: 3 * 60_000 } as const;

/**
 * When a live moment in this status is clearly past its bound, so it no
 * longer holds the host's one-auction lock: offering 10 s after joining
 * closes, bidding 30 s after the hard close, negotiating 30 s after its time
 * cap, awarded 3 min after it started (and never while its hold is still
 * active: the pay deadline is still coming). Null for statuses that never block.
 */
export function stuckAfter(
  m: { status: string; startedAt: number; offerClosesAt: number; biddingClosesAt?: number; hardClosesAt?: number },
  activeHoldExpiresAt: number | null = null,
): number | null {
  switch (m.status) {
    case "offering":
      return m.offerClosesAt + STUCK_GRACE.offeringMs;
    case "bidding":
      return (m.hardClosesAt ?? m.biddingClosesAt ?? m.offerClosesAt) + STUCK_GRACE.biddingMs;
    case "negotiating":
      return m.startedAt + NEGOTIATION_TIME_CAP_MS + STUCK_GRACE.negotiatingMs;
    case "awarded":
      return Math.max(m.startedAt + STUCK_GRACE.awardedMs, activeHoldExpiresAt ?? 0);
    default:
      return null;
  }
}
