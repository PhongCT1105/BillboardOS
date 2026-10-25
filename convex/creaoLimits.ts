/**
 * Rate limits and workpool for CREAO / research background jobs.
 * Fast 30s rounds never go through this path.
 */
import { RateLimiter, HOUR, MINUTE } from "@convex-dev/rate-limiter";
import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api";

/** Bound parallel CREAO/research actions so harness ticks can't stampede credits. */
export const creaoPool = new Workpool(components.creaoWorkpool, {
  maxParallelism: 3,
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
