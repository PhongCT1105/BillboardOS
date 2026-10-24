import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { recordAudit } from "./lib/audit";
import { requireOperator } from "./lib/operator";

/** Who is signed in, and whether they are an operator. null when signed out. */
export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      userId: v.id("users"),
      email: v.union(v.string(), v.null()),
      isOperator: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    const op = await ctx.db
      .query("operators")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    return { userId, email: user?.email ?? null, isOperator: op !== null };
  },
});

/** Operators (max 50). Operator only. */
export const list = query({
  args: {},
  returns: v.array(v.object({ userId: v.id("users"), email: v.string(), grantedBy: v.string() })),
  handler: async (ctx) => {
    await requireOperator(ctx);
    const rows = await ctx.db.query("operators").take(50);
    return rows.map((r) => ({ userId: r.userId, email: r.email, grantedBy: r.grantedBy }));
  },
});

/** An operator grants operator access to an existing account (by sign-up email). */
export const grant = mutation({
  args: { email: v.string() },
  returns: v.object({ userId: v.id("users"), email: v.string(), alreadyOperator: v.boolean() }),
  handler: async (ctx, args) => {
    const granter = await requireOperator(ctx);
    const email = args.email.trim().toLowerCase();
    if (email.length === 0 || email.length > 254) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "email is required" });
    }
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (!user) {
      throw new ConvexError({
        code: "USER_NOT_FOUND",
        message: "No account with that email; they must sign up first",
      });
    }
    const existing = await ctx.db
      .query("operators")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (existing) return { userId: user._id, email, alreadyOperator: true };
    await ctx.db.insert("operators", { userId: user._id, email, grantedBy: granter.actor });
    await recordAudit(ctx, {
      traceId: "auth:operators",
      actor: granter.actor,
      type: "operator.granted",
      subjectId: user._id,
      reason: `${granter.email} granted operator access to ${email}`,
    });
    return { userId: user._id, email, alreadyOperator: false };
  },
});

/**
 * Admin cleanup (CLI only): delete an account, its sessions/tokens and any
 * operator grant, e.g. if the wrong person created the first account.
 * `npx convex run operators:removeAccount '{"email":"x@y.z"}'`
 * Audit history is kept; a grant removal is not audited as a grant.
 */
export const removeAccount = internalMutation({
  args: { email: v.string() },
  returns: v.object({ removed: v.boolean(), wasOperator: v.boolean() }),
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (!user) return { removed: false, wasOperator: false };
    const op = await ctx.db
      .query("operators")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (op) await ctx.db.delete(op._id);
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .take(100);
    for (const session of sessions) {
      const tokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
        .take(100);
      for (const token of tokens) await ctx.db.delete(token._id);
      await ctx.db.delete(session._id);
    }
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id))
      .take(20);
    for (const account of accounts) {
      const codes = await ctx.db
        .query("authVerificationCodes")
        .withIndex("accountId", (q) => q.eq("accountId", account._id))
        .take(20);
      for (const code of codes) await ctx.db.delete(code._id);
      await ctx.db.delete(account._id);
    }
    await ctx.db.delete(user._id);
    return { removed: true, wasOperator: op !== null };
  },
});
