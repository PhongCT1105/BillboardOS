import { v } from "convex/values";
import { query } from "./_generated/server";
import { auditEventDoc } from "./lib/validators";
import { requireOperator } from "./lib/operator";

/** Latest 50 audit events, newest first (operator activity log). */
export const recent = query({
  args: {},
  returns: v.array(auditEventDoc),
  handler: async (ctx) => {
    await requireOperator(ctx);
    return await ctx.db.query("auditEvents").order("desc").take(50);
  },
});

/** Every event for one quote -> hold -> payment -> booking chain (max 200), oldest first. */
export const forTrace = query({
  args: { traceId: v.string() },
  returns: v.array(auditEventDoc),
  handler: async (ctx, args) => {
    await requireOperator(ctx);
    return await ctx.db
      .query("auditEvents")
      .withIndex("by_trace", (q) => q.eq("traceId", args.traceId))
      .take(200);
  },
});
