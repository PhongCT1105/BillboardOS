import { v } from "convex/values";
import { query } from "./_generated/server";
import { auditEventDoc } from "./lib/validators";
import { resolveWorkspace } from "./lib/tenancy";

/** Latest 50 audit events of the caller's workspace, newest first (activity log). */
export const recent = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(auditEventDoc),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    return await ctx.db
      .query("auditEvents")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .order("desc")
      .take(50);
  },
});

/** One quote -> hold -> payment -> booking chain (max 200, oldest first), this workspace's events only. */
export const forTrace = query({
  args: { traceId: v.string(), workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(auditEventDoc),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const rows = await ctx.db
      .query("auditEvents")
      .withIndex("by_trace", (q) => q.eq("traceId", args.traceId))
      .take(200);
    return rows.filter((e) => e.workspaceId === me.workspaceId);
  },
});
