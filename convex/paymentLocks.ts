import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * One paid attempt per resource at a time (a hold, or a report for one key),
 * so two concurrent retries of the same purchase can't both settle. Locks
 * expire on their own if an action dies mid-flight.
 */

export const acquire = internalMutation({
  args: { key: v.string(), ttlMs: v.number() },
  returns: v.union(v.id("paymentLocks"), v.null()),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("paymentLocks")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (existing && existing.expiresAt > now) return null;
    if (existing) await ctx.db.delete(existing._id);
    const ttl = Math.max(1_000, Math.min(10 * 60_000, args.ttlMs));
    return await ctx.db.insert("paymentLocks", { key: args.key, expiresAt: now + ttl });
  },
});

export const release = internalMutation({
  args: { lockId: v.id("paymentLocks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.lockId)) await ctx.db.delete(args.lockId);
    return null;
  },
});
