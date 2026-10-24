import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { workspaceRole } from "./schema";
import { recordAudit } from "./lib/audit";
import { PAYOUT_ADDRESS_RE, getProfile, requireUser, requireWorkspaceMember, resolveWorkspace } from "./lib/tenancy";

/** Host onboarding: create a workspace (you become its owner and it becomes active). */
export const create = mutation({
  args: { name: v.string(), city: v.string() },
  returns: v.id("workspaces"),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const profile = await getProfile(ctx, user.userId);
    if (profile?.accountType !== "host") {
      throw new ConvexError({ code: "HOST_ONLY", message: "Only host accounts create workspaces" });
    }
    const name = args.name.trim();
    const city = args.city.trim();
    if (name.length === 0 || name.length > 80 || city.length === 0 || city.length > 80) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Name and city must be 1..80 characters" });
    }
    const workspaceId = await ctx.db.insert("workspaces", { name, city, ownerUserId: user.userId });
    await ctx.db.insert("workspaceMembers", { workspaceId, userId: user.userId, email: user.email, role: "owner" });
    await ctx.db.patch(profile._id, { activeWorkspaceId: workspaceId });
    await recordAudit(ctx, {
      workspaceId,
      traceId: `workspace:${workspaceId}`,
      actor: `operator:${user.email}`,
      type: "workspace.created",
      subjectId: workspaceId,
      reason: `${user.email} created workspace ${name} (${city})`,
    });
    return workspaceId;
  },
});

/** The active (or given) workspace with its members. Members only. */
export const get = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    city: v.string(),
    payoutAddress: v.union(v.string(), v.null()),
    myRole: workspaceRole,
    members: v.array(v.object({ userId: v.id("users"), email: v.string(), role: workspaceRole })),
  }),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const workspace = (await ctx.db.get(me.workspaceId))!;
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .take(50);
    return {
      workspaceId: workspace._id,
      name: workspace.name,
      city: workspace.city,
      payoutAddress: workspace.payoutAddress ?? null,
      myRole: me.role,
      members: members.map((m) => ({ userId: m.userId, email: m.email, role: m.role })),
    };
  },
});

/** Owner invites an existing user (by sign-up email) as operator or co-owner. */
export const invite = mutation({
  args: { workspaceId: v.id("workspaces"), email: v.string(), role: v.optional(workspaceRole) },
  returns: v.object({ userId: v.id("users"), alreadyMember: v.boolean() }),
  handler: async (ctx, args) => {
    const owner = await requireWorkspaceMember(ctx, args.workspaceId, "owner");
    const email = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (!user) {
      throw new ConvexError({ code: "USER_NOT_FOUND", message: "No account with that email; they must sign up first" });
    }
    const existing = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", user._id))
      .unique();
    if (existing) return { userId: user._id, alreadyMember: true };
    await ctx.db.insert("workspaceMembers", {
      workspaceId: args.workspaceId,
      userId: user._id,
      email,
      role: args.role ?? "operator",
    });
    const profile = await getProfile(ctx, user._id);
    if (!profile) await ctx.db.insert("profiles", { userId: user._id, accountType: "host", activeWorkspaceId: args.workspaceId });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      traceId: `workspace:${args.workspaceId}`,
      actor: owner.actor,
      type: "workspace.member_added",
      subjectId: user._id,
      reason: `${owner.email} added ${email} as ${args.role ?? "operator"}`,
    });
    return { userId: user._id, alreadyMember: false };
  },
});

/** Owner sets where x402 payments for this workspace's sales go (EVM address). */
export const setPayoutAddress = mutation({
  args: { workspaceId: v.id("workspaces"), payoutAddress: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireWorkspaceMember(ctx, args.workspaceId, "owner");
    const address = args.payoutAddress?.trim() || null;
    if (address !== null && !PAYOUT_ADDRESS_RE.test(address)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Payout address must be 0x followed by 40 hex characters" });
    }
    await ctx.db.patch(args.workspaceId, { payoutAddress: address ?? undefined });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      traceId: `workspace:${args.workspaceId}`,
      actor: owner.actor,
      type: "workspace.payout_changed",
      subjectId: args.workspaceId,
      reason: address ? `Payout address set to ${address}` : "Payout address cleared",
    });
    return null;
  },
});
