import { v } from "convex/values";
import { query } from "./_generated/server";
import { financeExceptionDoc } from "./lib/validators";

/** Open finance exceptions needing operator review, newest first (max 100). */
export const openExceptions = query({
  args: {},
  returns: v.array(financeExceptionDoc),
  handler: async (ctx) => {
    return await ctx.db
      .query("financeExceptions")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .order("desc")
      .take(100);
  },
});
