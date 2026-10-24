import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { audienceSource } from "./schema";

/** Audience is aggregated into 15-minute buckets (matches slot length). */
export const AUDIENCE_BUCKET_MS = 15 * 60 * 1000;
const MAX_COUNT = 100_000;

/**
 * Record an aggregate audience count for the current 15-minute bucket.
 * Upserts: a later report for the same billboard+bucket replaces the earlier one.
 * Only aggregate counts are stored, never images or identities.
 *
 * TODO(auth): unauthenticated for the demo. Before anything public, require a
 * per-device secret (HTTP action with bearer token) or move behind auth.
 */
export const record = mutation({
  args: {
    billboardId: v.id("billboards"),
    countEstimate: v.number(),
    source: audienceSource,
    confidence: v.number(),
  },
  returns: v.object({
    aggregateId: v.id("audienceAggregates"),
    bucketStart: v.number(),
  }),
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.countEstimate) ||
      args.countEstimate < 0 ||
      args.countEstimate > MAX_COUNT
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `countEstimate must be an integer in [0, ${MAX_COUNT}]`,
      });
    }
    if (!Number.isFinite(args.confidence) || args.confidence < 0 || args.confidence > 1) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "confidence must be in [0, 1]" });
    }
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    }

    const now = Date.now();
    const bucketStart = now - (now % AUDIENCE_BUCKET_MS);
    const existing = await ctx.db
      .query("audienceAggregates")
      .withIndex("by_billboard_and_bucketStart", (q) =>
        q.eq("billboardId", args.billboardId).eq("bucketStart", bucketStart),
      )
      .first();

    const fields = {
      countEstimate: args.countEstimate,
      source: args.source,
      confidence: args.confidence,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { aggregateId: existing._id, bucketStart };
    }
    const aggregateId = await ctx.db.insert("audienceAggregates", {
      billboardId: args.billboardId,
      bucketStart,
      ...fields,
    });
    return { aggregateId, bucketStart };
  },
});
