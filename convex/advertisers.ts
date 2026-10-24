import { v } from "convex/values";
import { query } from "./_generated/server";
import { advertiserDoc } from "./lib/validators";

/** Advertisers (max 50). */
export const list = query({
  args: {},
  returns: v.array(advertiserDoc),
  handler: async (ctx) => {
    return await ctx.db.query("advertisers").take(50);
  },
});
