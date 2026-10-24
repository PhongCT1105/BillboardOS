import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export type Operator = {
  userId: Id<"users">;
  email: string;
  /** Audit actor / approver identity: "operator:<email>". */
  actor: string;
};

/** The signed-in operator, or null (not signed in / not an operator). */
export async function getOperator(ctx: QueryCtx | MutationCtx): Promise<Operator | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const op = await ctx.db
    .query("operators")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (!op) return null;
  return { userId, email: op.email, actor: `operator:${op.email}` };
}

/**
 * Throws ConvexError UNAUTHENTICATED (no session) or NOT_OPERATOR (signed in,
 * but no operator grant). Identity always comes from the session, never args.
 */
export async function requireOperator(ctx: QueryCtx | MutationCtx): Promise<Operator> {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in as an operator first" });
  }
  const op = await getOperator(ctx);
  if (!op) {
    throw new ConvexError({
      code: "NOT_OPERATOR",
      message: "This account is not an operator; ask an existing operator to grant access",
    });
  }
  return op;
}

/**
 * Convex Auth callback body: the very first account becomes an operator.
 * Later accounts need operators.grant. Idempotent; returns whether it granted.
 */
export async function ensureFirstOperator(ctx: MutationCtx, userId: Id<"users">): Promise<boolean> {
  const anyOperator = await ctx.db.query("operators").first();
  if (anyOperator) return false;
  const user = await ctx.db.get(userId);
  const email = user?.email ?? "unknown";
  await ctx.db.insert("operators", { userId, email, grantedBy: "system:first-user" });
  await ctx.db.insert("auditEvents", {
    traceId: "auth:operators",
    actor: "system",
    type: "operator.granted",
    subjectId: userId,
    reason: `First account ${email} became the operator`,
  });
  return true;
}
