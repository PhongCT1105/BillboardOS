import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { audienceSource } from "./schema";

import { AUDIENCE_BUCKET_MS } from "./lib/pricing";
import { requireWorkspaceMember, workspaceOfBillboard } from "./lib/tenancy";

export { AUDIENCE_BUCKET_MS };
const MAX_COUNT = 100_000;

/**
 * Record an aggregate audience count for the current 15-minute bucket.
 * Upserts: a later report for the same billboard+bucket replaces the earlier one.
 * Only aggregate counts are stored, never images or identities.
 *
 * Operator only: the sensor laptop signs in as an operator.
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
    // The sensor laptop signs in as a member of the screen's workspace.
    await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
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
      workspaceId: billboard.workspaceId,
      billboardId: args.billboardId,
      bucketStart,
      ...fields,
    });
    return { aggregateId, bucketStart };
  },
});

const MAX_ARRIVALS_PER_CALL = 500;
const MAX_PEAK_IN_VIEW = 500;

/**
 * Browser/edge camera counter: add new arrivals to the current 15-minute
 * bucket (server-side, so a page reload never loses counts), keep the max
 * people-in-view (dwell proxy), and the latest confidence/source.
 * Only aggregate counts are stored, never images or identities.
 *
 * Operator only: the sensor laptop signs in as an operator.
 */
export const addArrivals = mutation({
  args: {
    billboardId: v.id("billboards"),
    arrivals: v.number(),
    peakInView: v.number(),
    confidence: v.number(),
    source: audienceSource,
  },
  returns: v.object({
    aggregateId: v.id("audienceAggregates"),
    bucketStart: v.number(),
    countEstimate: v.number(),
    peakInView: v.number(),
  }),
  handler: async (ctx, args) => {
    // The sensor laptop signs in as a member of the screen's workspace.
    await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
    if (!Number.isSafeInteger(args.arrivals) || args.arrivals < 0 || args.arrivals > MAX_ARRIVALS_PER_CALL) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `arrivals must be an integer in [0, ${MAX_ARRIVALS_PER_CALL}]`,
      });
    }
    if (!Number.isSafeInteger(args.peakInView) || args.peakInView < 0 || args.peakInView > MAX_PEAK_IN_VIEW) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `peakInView must be an integer in [0, ${MAX_PEAK_IN_VIEW}]`,
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

    if (existing) {
      const countEstimate = Math.min(MAX_COUNT, existing.countEstimate + args.arrivals);
      const peakInView = Math.max(existing.peakInView ?? 0, args.peakInView);
      await ctx.db.patch(existing._id, {
        countEstimate,
        peakInView,
        confidence: args.confidence,
        source: args.source,
      });
      return { aggregateId: existing._id, bucketStart, countEstimate, peakInView };
    }
    const aggregateId = await ctx.db.insert("audienceAggregates", {
      workspaceId: billboard.workspaceId,
      billboardId: args.billboardId,
      bucketStart,
      countEstimate: args.arrivals,
      peakInView: args.peakInView,
      source: args.source,
      confidence: args.confidence,
    });
    return { aggregateId, bucketStart, countEstimate: args.arrivals, peakInView: args.peakInView };
  },
});

/** Last 48 audience buckets (12h) for a billboard, oldest first, for a sparkline. */
export const recentForBillboard = query({
  args: { billboardId: v.id("billboards") },
  returns: v.array(
    v.object({
      bucketStart: v.number(),
      countEstimate: v.number(),
      source: audienceSource,
      confidence: v.number(),
      peakInView: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("audienceAggregates")
      .withIndex("by_billboard_and_bucketStart", (q) => q.eq("billboardId", args.billboardId))
      .order("desc")
      .take(48);
    return rows.reverse().map((r) => ({
      bucketStart: r.bucketStart,
      countEstimate: r.countEstimate,
      source: r.source,
      confidence: r.confidence,
      peakInView: r.peakInView,
    }));
  },
});
