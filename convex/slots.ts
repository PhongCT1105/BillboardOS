import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { slotDoc } from "./lib/validators";

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SLOTS = 200;

/** Slots on one billboard whose start time is in [from, to], oldest first (max 200, window <= 7 days). */
export const listForBillboard = query({
  args: {
    billboardId: v.id("billboards"),
    from: v.number(),
    to: v.number(),
  },
  returns: v.array(slotDoc),
  handler: async (ctx, args) => {
    if (
      !Number.isFinite(args.from) ||
      !Number.isFinite(args.to) ||
      args.to < args.from ||
      args.to - args.from > MAX_WINDOW_MS
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Require finite from <= to with a window of at most 7 days",
      });
    }
    return await ctx.db
      .query("slots")
      .withIndex("by_billboard_and_startAt", (q) =>
        q.eq("billboardId", args.billboardId).gte("startAt", args.from).lte("startAt", args.to),
      )
      .take(MAX_SLOTS);
  },
});
