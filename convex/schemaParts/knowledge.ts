import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Tables for YouTube creatives, the company knowledge base and the creative
 * review agent (ADR 0007 section 4). Spread into `schema.ts` as one line.
 */

export const knowledgeMethod = v.union(v.literal("claude"), v.literal("heuristic"), v.literal("curated"));
export const reviewMethod = v.union(v.literal("claude"), v.literal("creao"), v.literal("heuristic"));

export const companyStage = v.union(
  v.literal("startup"),
  v.literal("growth"),
  v.literal("established"),
  v.literal("enterprise"),
  v.literal("unknown"),
);

export const knowledgeCardFields = {
  advertiserId: v.id("advertisers"),
  /** Public, company-level: what the company does. Never quotes briefs or budgets. */
  summary: v.string(),
  /** Lowercase category, e.g. "developer tools", "food & beverage", "gambling". */
  category: v.string(),
  stage: companyStage,
  /** Who the company's ads are for (same vocabulary as campaign.targetAudience). */
  audienceTags: v.record(v.string(), v.number()),
  /** Stage and audience weights can be project inferences rather than source facts. */
  derivedFieldsNote: v.optional(v.string()),
  /** Public URLs (company research, YouTube videos). */
  sources: v.array(v.string()),
  /** Public YouTube titles of the company's linked videos. */
  videoTitles: v.array(v.string()),
  method: knowledgeMethod,
  model: v.optional(v.string()),
  updatedAt: v.number(),
  /** Last time a rebuild was scheduled (debounce). */
  buildRequestedAt: v.optional(v.number()),
  /** Set while this is the quick guess and Claude is still writing the real card. */
  refining: v.optional(v.boolean()),
};

export const oembedStatus = v.union(v.literal("pending"), v.literal("ok"), v.literal("failed"));

/** A campaign's YouTube creative (one per campaign). The campaign row carries creativeContentType "youtube". */
export const youtubeCreativeFields = {
  campaignId: v.id("campaigns"),
  advertiserId: v.id("advertisers"),
  videoId: v.string(),
  /** Canonical watch URL. */
  url: v.string(),
  title: v.optional(v.string()),
  author: v.optional(v.string()),
  authorUrl: v.optional(v.string()),
  /** From the public watch page (best effort): what the video says about itself. */
  description: v.optional(v.string()),
  keywords: v.optional(v.array(v.string())),
  thumbnailUrl: v.string(),
  oembedStatus,
  oembedError: v.optional(v.string()),
  fetchedAt: v.optional(v.number()),
  attachedAt: v.number(),
};

export const reviewVerdict = v.union(
  /** Safe and allowed: approved for this workspace by the agent. */
  v.literal("approved"),
  /** Unsafe or a blocked category: left pending for the host. */
  v.literal("flagged"),
  /** Safe, but this workspace turned auto-approve off: left pending for the host. */
  v.literal("held"),
  /** The host had already decided; the agent changed nothing. */
  v.literal("skipped"),
);

export const creativeReviewFields = {
  campaignId: v.id("campaigns"),
  workspaceId: v.id("workspaces"),
  verdict: reviewVerdict,
  safe: v.boolean(),
  categories: v.array(v.string()),
  reason: v.string(),
  /** The agent's content finding, before this workspace's policy (re-applied when the policy changes). */
  contentReason: v.optional(v.string()),
  method: reviewMethod,
  model: v.optional(v.string()),
  /** Which creative was reviewed (storage id or "youtube:<id>"); a newer upload makes it stale. */
  creativeRef: v.string(),
  reviewedAt: v.number(),
};

export const knowledgeTables = {
  companyKnowledgePassages: defineTable({
    advertiserId: v.id("advertisers"),
    passageKey: v.string(),
    title: v.string(),
    url: v.string(),
    text: v.string(),
    sourceKind: v.union(v.literal("official_site"), v.literal("official_video")),
    verifiedAt: v.number(),
    contentHash: v.string(),
    active: v.boolean(),
    embeddingStatus: v.union(v.literal("pending"), v.literal("ready")),
    embedding: v.optional(v.array(v.float64())),
    embeddingModel: v.optional(v.string()),
    embeddingHash: v.optional(v.string()),
    embeddedAt: v.optional(v.number()),
  })
    .index("by_advertiser_and_passageKey", ["advertiserId", "passageKey"])
    .index("by_advertiser_and_active", ["advertiserId", "active"])
    .index("by_active_and_embeddingStatus", ["active", "embeddingStatus"])
    .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1024, filterFields: ["advertiserId"] }),
  knowledgeCards: defineTable(knowledgeCardFields)
    .index("by_advertiser", ["advertiserId"])
    .searchIndex("search_summary", { searchField: "summary", filterFields: ["category"] }),

  youtubeCreatives: defineTable(youtubeCreativeFields)
    .index("by_campaign", ["campaignId"])
    .index("by_advertiser", ["advertiserId"]),

  /** Per-workspace creative review policy; no row = defaults (auto-approve on, standard blocked list). */
  creativeReviewPolicies: defineTable({
    workspaceId: v.id("workspaces"),
    autoApprove: v.boolean(),
    blockedCategories: v.array(v.string()),
    updatedAt: v.number(),
    updatedBy: v.string(),
  }).index("by_workspace", ["workspaceId"]),

  /** Latest creative review agent verdict per workspace and campaign. */
  creativeReviews: defineTable(creativeReviewFields)
    .index("by_workspace_and_campaign", ["workspaceId", "campaignId"])
    .index("by_campaign", ["campaignId"]),
};
