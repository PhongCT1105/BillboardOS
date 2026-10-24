import { v } from "convex/values";
import { query } from "./_generated/server";
import { playbackEventDoc } from "./lib/validators";

/** Latest 20 playback receipts for a billboard, newest first. */
export const recentForBillboard = query({
  args: { billboardId: v.id("billboards") },
  returns: v.array(playbackEventDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("playbackEvents")
      .withIndex("by_billboard", (q) => q.eq("billboardId", args.billboardId))
      .order("desc")
      .take(20);
  },
});
