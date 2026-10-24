import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { advertiserDoc } from "./lib/validators";
import { requireUser } from "./lib/tenancy";

/** The customer companies the caller acts for (max 20). */
export const list = query({
  args: {},
  returns: v.array(advertiserDoc),
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const memberships = await ctx.db
      .query("advertiserMembers")
      .withIndex("by_user", (q) => q.eq("userId", user.userId))
      .take(20);
    const rows: Doc<"advertisers">[] = [];
    for (const m of memberships) {
      const a = await ctx.db.get(m.advertiserId);
      if (a) rows.push(a);
    }
    return rows;
  },
});
