/**
 * The live moment (ADR 0006), pure parts: detector maths, flash spot pricing,
 * standing-instruction checks and winner selection. Code decides every
 * number; reasoning strings explain them.
 */
import { matchScore, normalizeTags, type AudienceTags } from "./match";

export type MomentSettings = {
  enabled: boolean;
  /** People in view needed before a screen goes live. */
  minPeopleInView: number;
  /** How long a company agent has to join an auction. */
  joinWindowMs: number;
  /** Campaign audience match needed to be offered the spot (0..1). */
  minMatch: number;
};

export const DEFAULT_MOMENT_SETTINGS: MomentSettings = {
  enabled: true,
  minPeopleInView: 1,
  joinWindowMs: 2_000,
  minMatch: 0.3,
};

export const MOMENT_LIMITS = {
  minPeopleInView: { min: 1, max: 10_000 },
  joinWindowMs: { min: 1_000, max: 10_000 },
  minMatch: { min: 0, max: 1 },
} as const;

/** Sell the in-progress slot only if at least this much of it is left. */
export const MIN_REMAINING_MS = 3 * 60_000;
export const SLOT_MS = 15 * 60_000;
/** The winner has this long to pay before the next best offer is awarded. */
export const PAY_WINDOW_MS = 60_000;
export const MAX_OFFERS = 5;

export function momentSettingsOf(ws: {
  momentEnabled?: boolean;
  momentMinPeopleInView?: number;
  momentResponseWindowMs?: number;
  momentMinMatch?: number;
}): MomentSettings {
  const d = DEFAULT_MOMENT_SETTINGS;
  return {
    enabled: ws.momentEnabled ?? d.enabled,
    minPeopleInView: ws.momentMinPeopleInView ?? d.minPeopleInView,
    joinWindowMs: ws.momentResponseWindowMs ?? d.joinWindowMs,
    minMatch: ws.momentMinMatch ?? d.minMatch,
  };
}

export function validateMomentSettings(s: Omit<MomentSettings, "enabled">): string | null {
  const L = MOMENT_LIMITS;
  for (const key of ["minPeopleInView", "joinWindowMs", "minMatch"] as const) {
    const value = s[key];
    if (!Number.isFinite(value) || value < L[key].min || value > L[key].max) return `${key} must be between ${L[key].min} and ${L[key].max}`;
  }
  if (!Number.isInteger(s.minPeopleInView)) return "minPeopleInView must be a whole number";
  return null;
}

/** Per-segment audience mix: the larger of the screen's usual mix and the live event's draw. */
export function audienceMix(screenTags: AudienceTags | undefined, eventTags: AudienceTags | undefined): AudienceTags {
  const s = normalizeTags(screenTags);
  const e = normalizeTags(eventTags);
  const out: AudienceTags = {};
  for (const k of new Set([...Object.keys(s), ...Object.keys(e)])) out[k] = Math.max(s[k] ?? 0, e[k] ?? 0);
  return out;
}

export type Detection = {
  crowd: number;
  segment: string;
  segmentShare: number;
  relevantViewers: number;
  reasoning: string;
  fires: boolean;
};

/**
 * Relevant viewers = trailing crowd x the best segment's share (max of the
 * screen's usual mix and the live event's audience).
 */
export function detect(input: {
  crowd: number;
  crowdSimulated: boolean;
  screenTags: AudienceTags | undefined;
  event: { name: string; tags: AudienceTags | undefined; uplift: number } | null;
  threshold: number;
}): Detection {
  const screen = normalizeTags(input.screenTags);
  const event = normalizeTags(input.event?.tags);
  let segment = "general";
  let share = 1;
  let fromEvent = false;
  const keys = new Set([...Object.keys(screen), ...Object.keys(event)]);
  if (keys.size > 0) {
    share = -1;
    for (const k of keys) {
      const value = Math.max(screen[k] ?? 0, event[k] ?? 0);
      if (value > share) {
        share = value;
        segment = k;
        fromEvent = (event[k] ?? 0) > (screen[k] ?? 0);
      }
    }
  }
  const relevantViewers = Math.round(input.crowd * share);
  const parts = [`${input.crowd} people in the last 15 min${input.crowdSimulated ? " (SIMULATED crowd)" : ""}`];
  if (input.event) parts.push(`${input.event.name} next door${input.event.uplift > 1 ? ` (x${input.event.uplift.toFixed(1)})` : ""}`);
  parts.push(`${Math.round(share * 100)}% ${segment} audience${fromEvent ? " (from the event)" : ""} -> ~${relevantViewers} relevant viewers`);
  const fires = relevantViewers >= input.threshold;
  parts.push(fires ? `at or above the ${input.threshold} threshold: offering the next spot` : `below the ${input.threshold} threshold`);
  return { crowd: input.crowd, segment, segmentShare: share, relevantViewers, reasoning: parts.join("; "), fires };
}

/** Campaign fit for this moment: match against the live mix, and its relevant viewers. */
export function campaignFit(mix: AudienceTags, target: AudienceTags | undefined, crowd: number) {
  const m = matchScore(mix, target) ?? 0;
  return { matchScore: m, relevantViewers: Math.round(crowd * m) };
}

/** Pro-rata price for the minutes actually sold. */
export function proRata(slotPriceMinor: number, coveredMs: number): number {
  return Math.max(1, Math.round((slotPriceMinor * Math.min(coveredMs, SLOT_MS)) / SLOT_MS));
}

export type Standing = {
  maxPricePerSpotMinor: number;
  minRelevantViewers: number;
  dailyBudgetMinor: number;
  /** Legacy: kept so old rows validate; no new code writes it. */
  policy?: "auto_accept" | "counter" | "pass";
  counterRatio?: number;
};

export function validateStanding(s: Standing): string | null {
  if (!Number.isSafeInteger(s.maxPricePerSpotMinor) || s.maxPricePerSpotMinor <= 0 || s.maxPricePerSpotMinor > 10_000_000) {
    return "maxPricePerSpotMinor must be whole cents in (0, 10000000]";
  }
  if (!Number.isSafeInteger(s.minRelevantViewers) || s.minRelevantViewers < 0 || s.minRelevantViewers > 100_000) return "minRelevantViewers must be 0..100000";
  if (!Number.isSafeInteger(s.dailyBudgetMinor) || s.dailyBudgetMinor <= 0 || s.dailyBudgetMinor > 10_000_000) {
    return "dailyBudgetMinor must be whole cents in (0, 10000000]";
  }
  if (s.counterRatio !== undefined && (!Number.isFinite(s.counterRatio) || s.counterRatio < 0.5 || s.counterRatio > 1)) {
    return "counterRatio must be between 0.5 and 1";
  }
  return null;
}

/** Would this agent's standing instructions let it take the spot at the seller's floor? */
export function standingCovers(s: Standing | undefined, input: { floorMinor: number; relevantViewers: number; spentTodayMinor: number }): string | null {
  if (!s) return "no standing instructions";
  if (s.policy === "pass") return "standing policy is pass";
  if (s.maxPricePerSpotMinor < input.floorMinor) return "max price per spot is below the seller's floor";
  if (input.relevantViewers < s.minRelevantViewers) return `fewer than ${s.minRelevantViewers} relevant viewers`;
  if (input.spentTodayMinor + input.floorMinor > s.dailyBudgetMinor) return "daily budget exhausted";
  return null;
}

/** Server-side check of a reply amount against the agent's own standing instructions. */
export function replyAllowed(s: Standing | undefined, amountMinor: number, spentTodayMinor: number): string | null {
  if (!s) return null;
  if (amountMinor > s.maxPricePerSpotMinor) return `over the key's standing max of $${(s.maxPricePerSpotMinor / 100).toFixed(2)} per spot`;
  if (spentTodayMinor + amountMinor > s.dailyBudgetMinor) return "over the key's daily budget";
  return null;
}

/** What a hosted demo agent (or any policy-following agent) answers. */
export function standingDecision(
  s: Standing,
  offer: { priceMinor: number; relevantViewers: number },
): { decision: "accept" | "counter" | "pass"; amountMinor?: number; reasoning: string } {
  const usd = (m: number) => `$${(m / 100).toFixed(2)}`;
  if (s.policy === "pass") return { decision: "pass", reasoning: "Standing policy: pass on flash offers." };
  if (offer.relevantViewers < s.minRelevantViewers) {
    return { decision: "pass", reasoning: `${offer.relevantViewers} relevant viewers is under my minimum of ${s.minRelevantViewers}.` };
  }
  if (s.policy === "auto_accept" && offer.priceMinor <= s.maxPricePerSpotMinor) {
    return { decision: "accept", reasoning: `${usd(offer.priceMinor)} for ~${offer.relevantViewers} relevant viewers is within my ${usd(s.maxPricePerSpotMinor)} limit.` };
  }
  const counter = Math.min(s.maxPricePerSpotMinor, Math.round(offer.priceMinor * (s.counterRatio ?? 0.85)));
  if (counter >= offer.priceMinor) {
    return { decision: "accept", reasoning: `${usd(offer.priceMinor)} is within my limit.` };
  }
  return {
    decision: "counter",
    amountMinor: counter,
    reasoning: `Countering at ${usd(counter)} (${Math.round(((s.counterRatio ?? 0.85) * 100))}% of ask, capped at my ${usd(s.maxPricePerSpotMinor)} limit) for ~${offer.relevantViewers} relevant viewers.`,
  };
}

export type ReplyForRanking = { offerId: string; status: string; amountMinor: number | null; repliedAt: number | null };

/** Acceptable replies (accept, or counter at/above the floor), best first: highest amount, then earliest. */
export function rankReplies(replies: ReplyForRanking[], floorMinor: number): ReplyForRanking[] {
  return replies
    .filter((r) => (r.status === "accepted" || r.status === "countered") && r.amountMinor !== null && r.amountMinor >= floorMinor)
    .sort((a, b) => b.amountMinor! - a.amountMinor! || (a.repliedAt ?? 0) - (b.repliedAt ?? 0));
}
