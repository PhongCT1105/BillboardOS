import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { accountType, companyRole, companySize, workspaceRole } from "./schema";
import { recordAudit } from "./lib/audit";
import { getProfile, requireUser, requireWorkspaceMember } from "./lib/tenancy";
import { requestResearch } from "./research";

/**
 * Who is signed in, which side they chose, their workspaces (hosts) and
 * companies (customers). null when signed out.
 */
export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      userId: v.id("users"),
      email: v.union(v.string(), v.null()),
      accountType: v.union(accountType, v.null()),
      activeWorkspaceId: v.union(v.id("workspaces"), v.null()),
      workspaces: v.array(
        v.object({ workspaceId: v.id("workspaces"), name: v.string(), city: v.string(), role: workspaceRole }),
      ),
      companies: v.array(v.object({ advertiserId: v.id("advertisers"), displayName: v.string(), role: companyRole })),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    const profile = await getProfile(ctx, userId);
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(20);
    const workspaces = [];
    for (const m of memberships) {
      const w = await ctx.db.get(m.workspaceId);
      if (w) workspaces.push({ workspaceId: w._id, name: w.name, city: w.city, role: m.role });
    }
    const companyRows = await ctx.db
      .query("advertiserMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(20);
    const companies = [];
    for (const m of companyRows) {
      const a = await ctx.db.get(m.advertiserId);
      if (a) companies.push({ advertiserId: a._id, displayName: a.displayName, role: m.role });
    }
    const active =
      profile?.activeWorkspaceId && workspaces.some((w) => w.workspaceId === profile.activeWorkspaceId)
        ? profile.activeWorkspaceId
        : (workspaces[0]?.workspaceId ?? null);
    return {
      userId,
      email: user?.email ?? null,
      accountType: profile?.accountType ?? null,
      activeWorkspaceId: active,
      workspaces,
      companies,
    };
  },
});

/** Chosen once, right after sign-up: host (owns screens) or customer (buys ad time). */
export const setAccountType = mutation({
  args: { accountType },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const profile = await getProfile(ctx, user.userId);
    if (profile) {
      if (profile.accountType !== args.accountType) {
        throw new ConvexError({ code: "ACCOUNT_TYPE_SET", message: `This account is already a ${profile.accountType} account` });
      }
      return null;
    }
    await ctx.db.insert("profiles", { userId: user.userId, accountType: args.accountType });
    return null;
  },
});

/** Host: pick which workspace the console, finance desk and sensor show. */
export const setActiveWorkspace = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireWorkspaceMember(ctx, args.workspaceId);
    const profile = await getProfile(ctx, member.userId);
    if (profile) await ctx.db.patch(profile._id, { activeWorkspaceId: args.workspaceId });
    else await ctx.db.insert("profiles", { userId: member.userId, accountType: "host", activeWorkspaceId: args.workspaceId });
    return null;
  },
});

/**
 * Customer onboarding: create your company (you become its owner). Seeded
 * companies can't be claimed by name; they'll be attached by invite code later.
 */
export const createCompany = mutation({
  args: {
    name: v.string(),
    website: v.optional(v.string()),
    size: v.optional(companySize),
    /** Named automatically at sign-up: it takes its ad video's channel name later. */
    autoNamed: v.optional(v.boolean()),
  },
  returns: v.id("advertisers"),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const profile = await getProfile(ctx, user.userId);
    if (profile?.accountType !== "customer") {
      throw new ConvexError({ code: "CUSTOMER_ONLY", message: "Only customer accounts create companies" });
    }
    const name = args.name.trim();
    if (name.length === 0 || name.length > 80) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Company name must be 1..80 characters" });
    }
    const website = args.website?.trim() || undefined;
    if (website !== undefined && (!/^https?:\/\/[^\s]+\.[^\s]+$/.test(website) || website.length > 200)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Website must be an http(s) URL" });
    }
    const existing = await ctx.db
      .query("advertisers")
      .withIndex("by_displayName", (q) => q.eq("displayName", name))
      .first();
    if (existing) {
      throw new ConvexError({ code: "NAME_TAKEN", message: "A company with this name already exists" });
    }
    const advertiserId = await ctx.db.insert("advertisers", {
      displayName: name,
      paymentTerms: "prepay",
      ownerUserId: user.userId,
      website,
      size: args.size,
      autoNamed: args.autoNamed || undefined,
    });
    await ctx.db.insert("advertiserMembers", { advertiserId, userId: user.userId, email: user.email, role: "owner" });
    await requestResearch(ctx, advertiserId);
    await recordAudit(ctx, {
      traceId: `company:${advertiserId}`,
      actor: `customer:${user.email}`,
      type: "company.created",
      subjectId: advertiserId,
      reason: `${user.email} created customer company ${name}`,
    });
    return advertiserId;
  },
});

/**
 * Admin cleanup (CLI only): delete an account, its sessions/tokens, profile
 * and memberships. `npx convex run accounts:removeAccount '{"email":"x@y.z"}'`
 */
export const removeAccount = internalMutation({
  args: { email: v.string() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (!user) return { removed: false };
    const userId: Id<"users"> = user._id;
    for (const m of await ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", userId)).take(50)) {
      const workspace = await ctx.db.get(m.workspaceId);
      if (workspace?.ownerUserId === userId) await ctx.db.patch(workspace._id, { ownerUserId: undefined });
      await ctx.db.delete(m._id);
    }
    for (const m of await ctx.db.query("advertiserMembers").withIndex("by_user", (q) => q.eq("userId", userId)).take(50)) {
      const advertiser = await ctx.db.get(m.advertiserId);
      if (advertiser?.ownerUserId === userId) await ctx.db.patch(advertiser._id, { ownerUserId: undefined });
      await ctx.db.delete(m._id);
    }
    const profile = await getProfile(ctx, userId);
    if (profile) await ctx.db.delete(profile._id);
    for (const session of await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(100)) {
      for (const token of await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", session._id)).take(100)) {
        await ctx.db.delete(token._id);
      }
      await ctx.db.delete(session._id);
    }
    for (const account of await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).take(20)) {
      for (const code of await ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", account._id)).take(20)) {
        await ctx.db.delete(code._id);
      }
      await ctx.db.delete(account._id);
    }
    await ctx.db.delete(userId);
    return { removed: true };
  },
});
