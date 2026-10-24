import type { QueryCtx } from "../_generated/server";

/**
 * Purchase locks (paymentLocks.ts): one paid x402 attempt per resource at a
 * time. The x402 route takes the lock for a hold while a signed payment is
 * verified and settled, so the lifecycle can tell a payment is in flight.
 */

/** The lock key the x402 route uses for a hold. */
export const holdLockKey = (holdId: string) => `hold:${holdId}`;

/** True while an unexpired lock for `key` exists (a signed payment is verifying or settling). */
export async function lockHeld(ctx: QueryCtx, key: string, now: number): Promise<boolean> {
  const lock = await ctx.db
    .query("paymentLocks")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  return lock !== null && lock.expiresAt > now;
}
