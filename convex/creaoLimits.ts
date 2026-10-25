/**
 * Rate limits and workpool for CREAO / research background jobs.
 * Fast 30s rounds never go through this path.
 */
import { RateLimiter, HOUR, MINUTE } from "@convex-dev/rate-limiter";
import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api";

/** One CREAO/research action at a time: CREAO answers HTTP 429 to parallel runs. */
export const creaoPool = new Workpool(components.creaoWorkpool, {
  maxParallelism: 1,
  defaultRetryBehavior: {
    maxAttempts: 2,
    initialBackoffMs: 2_000,
    base: 2,
  },
  retryActionsByDefault: false,
});

/** Transactional CREAO start budget: 30 runs / hour globally, burst 5. */
export const creaoRateLimiter = new RateLimiter(components.rateLimiter, {
  creaoStart: { kind: "token bucket", rate: 30, period: HOUR, capacity: 5 },
  creaoInviteThink: { kind: "token bucket", rate: 20, period: HOUR, capacity: 3 },
  researchRefresh: { kind: "token bucket", rate: 60, period: HOUR, capacity: 8 },
  /** Keep a tiny limit so Bitdeer flash calls don't pile up from harnesses. */
  bitdeerAssist: { kind: "token bucket", rate: 120, period: MINUTE, capacity: 20 },
});

/** How long to wait when CREAO (or our start budget) is busy; null for any other error. */
export function creaoRetryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const ours = /CREAO rate-limited(?: for ([\d.]+)ms)?/.exec(message);
  if (ours) return Math.max(MINUTE, Math.ceil(Number(ours[1] ?? 0)));
  return message.includes("CREAO returned HTTP 429") ? 2 * MINUTE : null;
}
