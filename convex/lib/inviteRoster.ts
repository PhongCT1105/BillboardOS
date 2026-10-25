/**
 * Invite roster: pure ranking and cool-down rules for the network → top-10 path.
 * Rounds call these; CREAO never runs inside the 30s loop.
 */

import { WINDOW_MS } from "./rounds";

/** How many companies a billboard invites per window. */
export const ACTIVE_INVITE_LIMIT = 10;
/** Consecutive price rejects before a cool-down. */
export const REJECT_STREAK_THRESHOLD = 3;
/** How long a cool-down lasts, in sale windows. */
export const COOLDOWN_WINDOWS = 10;

export type InviteOutcome = "agreed" | "reject";

export type InviteStatSnapshot = {
  rejectStreak: number;
  cooledUntilAt?: number;
};

export type Rankable = {
  advertiserId: string;
  /** null when audience isn't known yet — treated as neutral 0.5 for ranking. */
  match: number | null;
  /** Optional Invite CREAO preference weight (default 0). Higher sorts first after match. */
  prefWeight?: number;
};

/** Match used for sorting when the screen or company profile is missing. */
export const NEUTRAL_RANK_MATCH = 0.5;

export function rankMatch(match: number | null): number {
  return match === null ? NEUTRAL_RANK_MATCH : match;
}

export function isCooled(stat: InviteStatSnapshot | null | undefined, now: number): boolean {
  return typeof stat?.cooledUntilAt === "number" && stat.cooledUntilAt > now;
}

export function coolDownUntil(now: number): number {
  return now + COOLDOWN_WINDOWS * WINDOW_MS;
}

/** After one round outcome: new streak and optional cool-down timestamp. */
export function applyOutcome(
  prev: InviteStatSnapshot | null | undefined,
  outcome: InviteOutcome,
  now: number,
): InviteStatSnapshot {
  if (outcome === "agreed") return { rejectStreak: 0 };
  const rejectStreak = (prev?.rejectStreak ?? 0) + 1;
  if (rejectStreak >= REJECT_STREAK_THRESHOLD) {
    return { rejectStreak, cooledUntilAt: coolDownUntil(now) };
  }
  return { rejectStreak, cooledUntilAt: prev?.cooledUntilAt };
}

/**
 * Rank eligible network members: higher match first, then pref weight, then id.
 * Callers must already exclude cooled-down and not-ready companies.
 */
export function rankTopInvites<T extends Rankable>(candidates: T[], limit: number = ACTIVE_INVITE_LIMIT): T[] {
  return [...candidates]
    .sort((a, b) => {
      const dm = rankMatch(b.match) - rankMatch(a.match);
      if (dm !== 0) return dm;
      const dw = (b.prefWeight ?? 0) - (a.prefWeight ?? 0);
      if (dw !== 0) return dw;
      return a.advertiserId < b.advertiserId ? -1 : a.advertiserId > b.advertiserId ? 1 : 0;
    })
    .slice(0, Math.max(0, limit));
}

/** Did this bid count as agreeing a price (success) vs rejecting / no deal? */
export function outcomeFromBidStatus(status: string, hadAgreement: boolean): InviteOutcome {
  if (hadAgreement || status === "bid" || status === "won") return "agreed";
  return "reject";
}
