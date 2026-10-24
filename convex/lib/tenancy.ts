import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Tenancy (ADR 0004). Hosts act inside a WORKSPACE they are a member of;
 * customers act for a COMPANY (advertiser) they are a member of. Identity
 * always comes from the session; workspace/company always comes from the
 * record being touched (or the caller's active workspace for list views).
 */

type Ctx = QueryCtx | MutationCtx;

export type SignedInUser = { userId: Id<"users">; email: string };

export type WorkspaceMember = SignedInUser & {
  workspaceId: Id<"workspaces">;
  role: "owner" | "operator";
  /** Audit / approver identity, e.g. "operator:ana@host.com". */
  actor: string;
};

export type CustomerMember = SignedInUser & {
  advertiserId: Id<"advertisers">;
  role: "owner" | "member";
  /** Audit identity, e.g. "customer:bo@brand.com". */
  actor: string;
};

export async function requireUser(ctx: Ctx): Promise<SignedInUser> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in first" });
  const user = await ctx.db.get(userId);
  if (!user) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Account not found; sign in again" });
  return { userId, email: user.email ?? "unknown" };
}

export async function getProfile(ctx: Ctx, userId: Id<"users">): Promise<Doc<"profiles"> | null> {
  return await ctx.db
    .query("profiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

/** Member of this workspace (optionally its owner), or throws. */
export async function requireWorkspaceMember(
  ctx: Ctx,
  workspaceId: Id<"workspaces"> | undefined | null,
  role?: "owner",
): Promise<WorkspaceMember> {
  const user = await requireUser(ctx);
  if (!workspaceId) {
    throw new ConvexError({ code: "NOT_WORKSPACE_MEMBER", message: "This record doesn't belong to your workspace" });
  }
  const member = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", user.userId))
    .unique();
  if (!member) {
    throw new ConvexError({ code: "NOT_WORKSPACE_MEMBER", message: "You are not a member of this workspace" });
  }
  if (role === "owner" && member.role !== "owner") {
    throw new ConvexError({ code: "OWNER_ONLY", message: "Only the workspace owner can do this" });
  }
  return { ...user, workspaceId, role: member.role, actor: `operator:${user.email}` };
}

/**
 * Workspace for list views: the explicit one (membership checked), else the
 * caller's active workspace, else their first membership.
 */
export async function resolveWorkspace(ctx: Ctx, workspaceId?: Id<"workspaces">): Promise<WorkspaceMember> {
  if (workspaceId) return await requireWorkspaceMember(ctx, workspaceId);
  const user = await requireUser(ctx);
  const profile = await getProfile(ctx, user.userId);
  if (profile?.activeWorkspaceId) {
    const active = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", profile.activeWorkspaceId!).eq("userId", user.userId))
      .unique();
    if (active) return { ...user, workspaceId: active.workspaceId, role: active.role, actor: `operator:${user.email}` };
  }
  const first = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", user.userId))
    .first();
  if (!first) throw new ConvexError({ code: "NO_WORKSPACE", message: "Create or join a host workspace first" });
  return { ...user, workspaceId: first.workspaceId, role: first.role, actor: `operator:${user.email}` };
}

/** Workspace that owns a billboard (throws for legacy rows not yet backfilled). */
export async function workspaceOfBillboard(ctx: Ctx, billboardId: Id<"billboards">): Promise<Id<"workspaces">> {
  const billboard = await ctx.db.get(billboardId);
  if (!billboard) throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
  if (!billboard.workspaceId) {
    throw new ConvexError({ code: "NOT_MIGRATED", message: "Billboard has no workspace yet; run the tenancy migration" });
  }
  return billboard.workspaceId;
}

/** Signed-in member of a customer company (the given one, or their first). */
export async function requireCustomer(ctx: Ctx, advertiserId?: Id<"advertisers">): Promise<CustomerMember> {
  const user = await requireUser(ctx);
  const membership = advertiserId
    ? await ctx.db
        .query("advertiserMembers")
        .withIndex("by_advertiser_and_user", (q) => q.eq("advertiserId", advertiserId).eq("userId", user.userId))
        .unique()
    : await ctx.db
        .query("advertiserMembers")
        .withIndex("by_user", (q) => q.eq("userId", user.userId))
        .first();
  if (!membership) {
    throw new ConvexError(
      advertiserId
        ? { code: "NOT_COMPANY_MEMBER", message: "You don't act for this company" }
        : { code: "NO_COMPANY", message: "Create your company first" },
    );
  }
  return {
    ...user,
    advertiserId: membership.advertiserId,
    role: membership.role,
    actor: `customer:${user.email}`,
  };
}

/** The caller must act for the company that owns this campaign. */
export async function requireCampaignAccess(
  ctx: Ctx,
  campaignId: Id<"campaigns">,
): Promise<{ campaign: Doc<"campaigns">; customer: CustomerMember }> {
  const campaign = await ctx.db.get(campaignId);
  if (!campaign) throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found" });
  const customer = await requireCustomer(ctx, campaign.advertiserId);
  return { campaign, customer };
}

export const PAYOUT_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
