import { v } from "convex/values";
import { query } from "./_generated/server";
import { billboardDoc } from "./lib/validators";

/** All billboards (bounded; inventory is small). */
export const list = query({
  args: {},
  returns: v.array(billboardDoc),
  handler: async (ctx) => {
    return await ctx.db.query("billboards").take(100);
  },
});
