/**
 * Creative review agent (ADR 0007, AI-native: hosts don't have to click
 * approve). When a creative is attached, the agent (creativeReviewNode.ts)
 * classifies it once: Claude (vision for images, text for YouTube and
 * others) when ANTHROPIC_API_KEY is set, else a text heuristic. Then each
 * host workspace's policy decides:
 *
 * - safe and not in a blocked category, auto-approve on: the creative is made
 *   ready on that workspace's screens (a `creativeApprovals` row by
 *   "agent:creative-review"), with the reason in the audit log;
 * - otherwise it stays pending with the flagged reason for the host.
 *
 * The host can always override with `creatives.setReady`; the agent never
 * touches an approval a person made, nor one a host removed. A new upload
 * clears every approval and review of the campaign and starts over.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { knowledgeMethod, reviewVerdict } from "./schemaParts/knowledge";
import { recordAudit } from "./lib/audit";
import { scheduleBooking } from "./lib/scheduling";
import { requireCampaignAccess, requireWorkspaceMember, resolveWorkspace } from "./lib/tenancy";
import {
  DEFAULT_POLICY,
  REVIEW_ACTOR,
  decideForWorkspace,
  normalizeCategories,
  type ContentVerdict,
  type Policy,
} from "./lib/creativeReview";
import { YOUTUBE_CONTENT_TYPE, hasCreative } from "./lib/youtube";

const MAX_WORKSPACES = 50;
const MAX_BOOKINGS_TO_SCHEDULE = 100;
const MAX_ROWS = 100;

// ---------------------------------------------------------------------------
// Helpers other modules call (creatives.ts)
// ---------------------------------------------------------------------------

/** Identifies the exact creative reviewed, so a newer upload makes old verdicts stale. */
export async function creativeRefOf(ctx: QueryCtx, campaign: Doc<"campaigns">): Promise<string | null> {
  if (campaign.creativeContentType === YOUTUBE_CONTENT_TYPE) {
    const yt = await youtubeOf(ctx, campaign._id);
    return yt ? `youtube:${yt.videoId}` : null;
  }
  return campaign.creativeStorageId ? `storage:${campaign.creativeStorageId}` : null;
}

export async function youtubeOf(ctx: QueryCtx, campaignId: Id<"campaigns">): Promise<Doc<"youtubeCreatives"> | null> {
  return await ctx.db
    .query("youtubeCreatives")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .unique();
}

/** A new creative replaces the old one: clear every approval and review of the campaign. */
export async function resetCreativeReviews(ctx: MutationCtx, campaignId: Id<"campaigns">): Promise<number> {
  const approvals = await ctx.db
    .query("creativeApprovals")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .take(MAX_ROWS);
  for (const a of approvals) await ctx.db.delete(a._id);
  const reviews = await ctx.db
    .query("creativeReviews")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .take(MAX_ROWS);
  for (const r of reviews) await ctx.db.delete(r._id);
  return approvals.length;
}

/** Run the review agent for this campaign's current creative, right after this transaction. */
export async function scheduleCreativeReview(ctx: MutationCtx, campaignId: Id<"campaigns">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.creativeReviewNode.review, { campaignId });
}

export async function policyOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Policy & { isDefault: boolean }> {
  const row = await ctx.db
    .query("creativeReviewPolicies")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return row
    ? { autoApprove: row.autoApprove, blockedCategories: row.blockedCategories, isDefault: false }
    : { ...DEFAULT_POLICY, isDefault: true };
}

/** The host decided by hand (creatives.setReady): the agent leaves this workspace alone for this creative. */
export async function recordHostDecision(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  workspaceId: Id<"workspaces">,
  ready: boolean,
  actor: string,
): Promise<void> {
  const creativeRef = await creativeRefOf(ctx, campaign);
  if (!creativeRef) return;
  const existing = await ctx.db
    .query("creativeReviews")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId).eq("campaignId", campaign._id))
    .unique();
  const reason = `${actor} ${ready ? "approved" : "removed"} it by hand`;
  if (existing) {
    await ctx.db.patch(existing._id, { verdict: "skipped", reason, creativeRef, reviewedAt: Date.now() });
  } else {
    await ctx.db.insert("creativeReviews", {
      campaignId: campaign._id,
      workspaceId,
      verdict: "skipped",
      safe: true,
      categories: [],
      reason,
      method: "heuristic",
      creativeRef,
      reviewedAt: Date.now(),
    });
  }
}

type Outcome = Doc<"creativeReviews">["verdict"];

/** Apply one workspace's policy to a content verdict; writes the approval, audit and review row. */
async function applyToWorkspace(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  workspaceId: Id<"workspaces">,
  content: ContentVerdict,
  creativeRef: string,
): Promise<Outcome> {
  const now = Date.now();
  const existing = await ctx.db
    .query("creativeReviews")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId).eq("campaignId", campaign._id))
    .unique();
  // The host already decided about this exact creative by hand.
  if (existing?.verdict === "skipped" && existing.creativeRef === creativeRef) return "skipped";

  const approval = await ctx.db
    .query("creativeApprovals")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId).eq("campaignId", campaign._id))
    .first();
  const decision = decideForWorkspace(content, await policyOf(ctx, workspaceId));
  let verdict: Outcome = decision.verdict;
  let reason = decision.reason;
  const traceId = `campaign:${campaign._id}`;

  if (approval && approval.approvedBy !== REVIEW_ACTOR) {
    verdict = "skipped";
    reason = `Already approved by ${approval.approvedBy}. Agent: ${decision.reason}`;
  } else if (decision.verdict === "approved") {
    if (!approval) {
      await ctx.db.insert("creativeApprovals", { campaignId: campaign._id, workspaceId, approvedBy: REVIEW_ACTOR, approvedAt: now });
      await recordAudit(ctx, {
        workspaceId,
        traceId,
        actor: REVIEW_ACTOR,
        type: "creative.ready",
        subjectId: campaign._id,
        reason: `Approved by creative review agent: ${reason}`.slice(0, 1000),
        data: { method: content.method, categories: content.categories, creativeRef },
      });
      // Like a host approval: this workspace's confirmed bookings of the campaign can now play.
      const bookings = await ctx.db
        .query("bookings")
        .withIndex("by_campaign_and_status", (q) => q.eq("campaignId", campaign._id).eq("status", "confirmed"))
        .take(MAX_BOOKINGS_TO_SCHEDULE);
      for (const booking of bookings) {
        if (booking.workspaceId === workspaceId) await scheduleBooking(ctx, booking, now, REVIEW_ACTOR);
      }
    }
  } else {
    if (approval) {
      // Only the agent's own approval is withdrawn (the policy changed).
      await ctx.db.delete(approval._id);
    }
    if (existing?.verdict !== verdict || existing.creativeRef !== creativeRef) {
      await recordAudit(ctx, {
        workspaceId,
        traceId,
        actor: REVIEW_ACTOR,
        type: "policy.evaluated",
        subjectId: campaign._id,
        reason: `Creative left for the host: ${reason}`.slice(0, 1000),
        data: { verdict, method: content.method, categories: content.categories, creativeRef },
      });
    }
  }

  const row = {
    campaignId: campaign._id,
    workspaceId,
    verdict,
    safe: content.safe,
    categories: content.categories.slice(0, 20),
    reason: reason.slice(0, 1000),
    contentReason: content.reason.slice(0, 600),
    method: content.method,
    model: content.model,
    creativeRef,
    reviewedAt: now,
  };
  if (existing) await ctx.db.replace(existing._id, row);
  else await ctx.db.insert("creativeReviews", row);
  return verdict;
}

function contentOf(row: Doc<"creativeReviews">): ContentVerdict {
  return {
    safe: row.safe,
    categories: row.categories,
    reason: row.contentReason ?? row.reason,
    method: row.method,
    model: row.model,
  };
}

// ---------------------------------------------------------------------------
// Internal: the agent's inputs and outputs
// ---------------------------------------------------------------------------

export const reviewInputs = internalQuery({
  args: { campaignId: v.id("campaigns") },
  returns: v.union(
    v.null(),
    v.object({
      creativeRef: v.string(),
      contentType: v.string(),
      storageUrl: v.union(v.string(), v.null()),
      fileSize: v.union(v.number(), v.null()),
      youtube: v.union(
        v.null(),
        v.object({ videoId: v.string(), title: v.union(v.string(), v.null()), author: v.union(v.string(), v.null()), thumbnailUrl: v.string() }),
      ),
      brief: v.string(),
      advertiserName: v.string(),
      knowledgeCategory: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign || !hasCreative(campaign)) return null;
    const creativeRef = await creativeRefOf(ctx, campaign);
    if (!creativeRef) return null;
    const yt = campaign.creativeContentType === YOUTUBE_CONTENT_TYPE ? await youtubeOf(ctx, campaign._id) : null;
    const file = campaign.creativeStorageId ? await ctx.db.system.get(campaign.creativeStorageId) : null;
    const card = await ctx.db
      .query("knowledgeCards")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", campaign.advertiserId))
      .unique();
    return {
      creativeRef,
      contentType: campaign.creativeContentType ?? "application/octet-stream",
      storageUrl: campaign.creativeStorageId ? await ctx.storage.getUrl(campaign.creativeStorageId) : null,
      fileSize: file?.size ?? null,
      youtube: yt ? { videoId: yt.videoId, title: yt.title ?? null, author: yt.author ?? null, thumbnailUrl: yt.thumbnailUrl } : null,
      brief: campaign.brief.slice(0, 1000),
      advertiserName: (await ctx.db.get(campaign.advertiserId))?.displayName ?? "Unknown company",
      knowledgeCategory: card?.category ?? null,
    };
  },
});

/** Apply the agent's content verdict to every host workspace (or the given ones). Stale verdicts are dropped. */
export const applyVerdict = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    creativeRef: v.string(),
    safe: v.boolean(),
    categories: v.array(v.string()),
    reason: v.string(),
    method: knowledgeMethod,
    model: v.optional(v.string()),
    workspaceIds: v.optional(v.array(v.id("workspaces"))),
  },
  returns: v.object({
    stale: v.boolean(),
    approved: v.number(),
    flagged: v.number(),
    held: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    const counts = { stale: false, approved: 0, flagged: 0, held: 0, skipped: 0 };
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign || campaign.status !== "active" || (await creativeRefOf(ctx, campaign)) !== args.creativeRef) {
      return { ...counts, stale: true };
    }
    const content: ContentVerdict = {
      safe: args.safe,
      categories: normalizeCategories(args.categories),
      reason: args.reason.trim().slice(0, 600) || "No reason given.",
      method: args.method,
      model: args.model,
    };
    const workspaceIds = args.workspaceIds
      ? args.workspaceIds.slice(0, MAX_WORKSPACES)
      : (await ctx.db.query("workspaces").take(MAX_WORKSPACES)).map((w) => w._id);
    for (const workspaceId of workspaceIds) {
      counts[await applyToWorkspace(ctx, campaign, workspaceId, content, args.creativeRef)]++;
    }
    return counts;
  },
});

/**
 * A new host workspace: apply earlier agent verdicts to it (no new model
 * calls), and review any creative that has none yet. Hook for workspaces.create.
 */
export const reviewForNewWorkspace = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ applied: v.number(), scheduled: v.number() }),
  handler: async (ctx, args) => {
    let applied = 0;
    let scheduled = 0;
    const candidates = [
      ...(await ctx.db.query("campaigns").withIndex("by_creativeStatus", (q) => q.eq("creativeStatus", "pending_review")).take(30)),
      ...(await ctx.db.query("campaigns").withIndex("by_creativeStatus", (q) => q.eq("creativeStatus", "approved")).take(30)),
    ];
    for (const campaign of candidates) {
      if (campaign.status !== "active" || !hasCreative(campaign)) continue;
      const creativeRef = await creativeRefOf(ctx, campaign);
      if (!creativeRef) continue;
      const earlier = (
        await ctx.db
          .query("creativeReviews")
          .withIndex("by_campaign", (q) => q.eq("campaignId", campaign._id))
          .take(MAX_ROWS)
      ).find((r) => r.creativeRef === creativeRef && r.verdict !== "skipped");
      if (earlier) {
        await applyToWorkspace(ctx, campaign, args.workspaceId, contentOf(earlier), creativeRef);
        applied++;
      } else {
        await scheduleCreativeReview(ctx, campaign._id);
        scheduled++;
      }
    }
    return { applied, scheduled };
  },
});

// ---------------------------------------------------------------------------
// Host: policy and what the agent did
// ---------------------------------------------------------------------------

const policyView = v.object({ autoApprove: v.boolean(), blockedCategories: v.array(v.string()), isDefault: v.boolean() });

/** This workspace's creative review policy (defaults until the owner changes it). */
export const policy = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: policyView,
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    return await policyOf(ctx, me.workspaceId);
  },
});

/** Owner only: change the policy. Re-applies it to the agent's earlier verdicts for this workspace (no new model calls). */
export const setPolicy = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    autoApprove: v.boolean(),
    blockedCategories: v.array(v.string()),
  },
  returns: policyView,
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    await requireWorkspaceMember(ctx, me.workspaceId, "owner");
    if (args.blockedCategories.length > 50) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "At most 50 blocked categories" });
    }
    const blockedCategories = normalizeCategories(args.blockedCategories);
    const fields = { workspaceId: me.workspaceId, autoApprove: args.autoApprove, blockedCategories, updatedAt: Date.now(), updatedBy: me.actor };
    const existing = await ctx.db
      .query("creativeReviewPolicies")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .unique();
    if (existing) await ctx.db.replace(existing._id, fields);
    else await ctx.db.insert("creativeReviewPolicies", fields);
    await recordAudit(ctx, {
      workspaceId: me.workspaceId,
      traceId: `workspace:${me.workspaceId}`,
      actor: me.actor,
      type: "workspace.policy_changed",
      subjectId: me.workspaceId,
      reason: `Creative review: auto-approve ${args.autoApprove ? "on" : "off"}; blocked: ${blockedCategories.join(", ") || "none"}`,
      data: { autoApprove: args.autoApprove, blockedCategories },
    });
    const reviews = await ctx.db
      .query("creativeReviews")
      .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", me.workspaceId))
      .take(MAX_ROWS);
    for (const r of reviews) {
      if (r.verdict === "skipped") continue;
      const campaign = await ctx.db.get(r.campaignId);
      if (!campaign || campaign.status !== "active" || (await creativeRefOf(ctx, campaign)) !== r.creativeRef) continue;
      await applyToWorkspace(ctx, campaign, me.workspaceId, contentOf(r), r.creativeRef);
    }
    return { autoApprove: args.autoApprove, blockedCategories, isDefault: false };
  },
});

const reviewView = v.object({
  campaignId: v.id("campaigns"),
  advertiserName: v.string(),
  brief: v.string(),
  verdict: reviewVerdict,
  reason: v.string(),
  /** Ready-to-show line, e.g. "Approved by creative review agent: <reason>". */
  label: v.string(),
  categories: v.array(v.string()),
  method: knowledgeMethod,
  reviewedAt: v.number(),
});

export function reviewLabel(verdict: Outcome, reason: string): string {
  switch (verdict) {
    case "approved":
      return `Approved by creative review agent: ${reason}`;
    case "flagged":
      return `Flagged by creative review agent: ${reason}`;
    case "held":
      return `Waiting for you (creative review agent): ${reason}`;
    case "skipped":
      return `Decided by a person: ${reason}`;
  }
}

async function toReviewView(ctx: QueryCtx, r: Doc<"creativeReviews">, campaign: Doc<"campaigns">) {
  return {
    campaignId: r.campaignId,
    advertiserName: (await ctx.db.get(campaign.advertiserId))?.displayName ?? "Unknown advertiser",
    brief: campaign.brief,
    verdict: r.verdict,
    reason: r.reason,
    label: reviewLabel(r.verdict, r.reason),
    categories: r.categories,
    method: r.method,
    reviewedAt: r.reviewedAt,
  };
}

/** Host: the agent's latest verdicts for this workspace, newest first (max 20). */
export const forWorkspace = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(reviewView),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const rows = await ctx.db
      .query("creativeReviews")
      .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", me.workspaceId))
      .take(MAX_ROWS);
    rows.sort((a, b) => b.reviewedAt - a.reviewedAt);
    const out = [];
    for (const r of rows.slice(0, 20)) {
      const campaign = await ctx.db.get(r.campaignId);
      if (campaign) out.push(await toReviewView(ctx, r, campaign));
    }
    return out;
  },
});

/** Host: the agent's verdict on one campaign's creative for this workspace (null if not reviewed yet). */
export const forCampaign = query({
  args: { campaignId: v.id("campaigns"), workspaceId: v.optional(v.id("workspaces")) },
  returns: v.union(reviewView, v.null()),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) return null;
    const r = await ctx.db
      .query("creativeReviews")
      .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", me.workspaceId).eq("campaignId", args.campaignId))
      .unique();
    return r ? await toReviewView(ctx, r, campaign) : null;
  },
});

/** Customer: how each host's review went for their own campaign's creative (max 20). */
export const forMyCampaign = query({
  args: { campaignId: v.id("campaigns") },
  returns: v.array(
    v.object({ workspaceName: v.string(), verdict: reviewVerdict, label: v.string(), reviewedAt: v.number() }),
  ),
  handler: async (ctx, args) => {
    await requireCampaignAccess(ctx, args.campaignId);
    const rows = await ctx.db
      .query("creativeReviews")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(20);
    const out = [];
    for (const r of rows) {
      const ws = await ctx.db.get(r.workspaceId);
      // Customers see the outcome, not the host's internal notes about a manual decision.
      const label = r.verdict === "skipped" ? "Decided by the host" : reviewLabel(r.verdict, r.reason);
      out.push({ workspaceName: ws?.name ?? "A host", verdict: r.verdict, label, reviewedAt: r.reviewedAt });
    }
    return out;
  },
});
