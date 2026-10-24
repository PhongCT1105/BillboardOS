/**
 * Company knowledge base (ADR 0007 section 4). One knowledge card per company:
 * what it does, category, stage and audience tags, built from the company
 * analyst's research (ADR 0003, Claude + web search), its campaigns and the
 * public YouTube titles of its ads. Claude writes the card when
 * ANTHROPIC_API_KEY is set; otherwise (or on any failure) a deterministic
 * heuristic does.
 *
 * Visibility (decided here, see knowledgeRules.ts): any signed-in account can
 * search the PUBLIC part of a card (name, summary, category, stage). Audience
 * tags, sources and video titles are returned only to the company's own
 * members and to host workspace members (they use them for targeting).
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { companyStage, knowledgeMethod } from "./schemaParts/knowledge";
import { requireUser } from "./lib/tenancy";
import { heuristicCard, knowledgeInputs, sourcesFrom, type KnowledgeInputs } from "./knowledgeRules";

/** Don't schedule another build for the same company within this window. */
const BUILD_DEBOUNCE_MS = 30_000;
const MAX_CAMPAIGNS = 20;
const MAX_VIDEOS = 10;
const MAX_SEARCH_RESULTS = 10;
const MAX_QUERY_LENGTH = 100;

/**
 * Schedule a (re)build of a company's knowledge card unless one was requested
 * in the last 30 s. Call from any mutation (company created, creative attached).
 */
export async function requestKnowledgeBuild(ctx: MutationCtx, advertiserId: Id<"advertisers">, reason: string): Promise<boolean> {
  const card = await ctx.db
    .query("knowledgeCards")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .unique();
  const now = Date.now();
  if (card?.buildRequestedAt !== undefined && now - card.buildRequestedAt < BUILD_DEBOUNCE_MS) return false;
  if (card) await ctx.db.patch(card._id, { buildRequestedAt: now });
  await ctx.scheduler.runAfter(0, internal.knowledge.buildForCompany, { advertiserId, reason: reason.slice(0, 200) });
  return true;
}

/** Internal entry for other modules (e.g. company creation): schedules a card build. */
export const requestBuild = internalMutation({
  args: { advertiserId: v.id("advertisers"), reason: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => await requestKnowledgeBuild(ctx, args.advertiserId, args.reason),
});

async function gather(ctx: QueryCtx, advertiserId: Id<"advertisers">): Promise<KnowledgeInputs | null> {
  const advertiser = await ctx.db.get(advertiserId);
  if (!advertiser) return null;
  const campaigns = await ctx.db
    .query("campaigns")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .order("desc")
    .take(MAX_CAMPAIGNS);
  const kept = campaigns.filter((c) => c.status !== "cancelled");
  const videos = await ctx.db
    .query("youtubeCreatives")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .order("desc")
    .take(MAX_VIDEOS);
  // Reuse the company analyst's latest platform research (never a workspace override).
  const assessments = await ctx.db
    .query("companyAssessments")
    .withIndex("by_advertiser_and_assessedAt", (q) => q.eq("advertiserId", advertiserId))
    .order("desc")
    .take(10);
  const research = assessments.find((a) => a.method !== "override") ?? null;
  return {
    displayName: advertiser.displayName,
    website: advertiser.website ?? null,
    size: advertiser.size ?? null,
    briefs: kept.map((c) => c.brief.slice(0, 500)),
    targetAudiences: kept.flatMap((c) => (c.targetAudience ? [c.targetAudience] : [])),
    videos: videos
      .filter((y) => y.title !== undefined)
      .map((y) => ({ title: y.title!, author: y.author ?? null, url: y.url })),
    research: research
      ? { brandTier: research.brandTier, reasoning: research.reasoning, sources: research.sources, method: research.method }
      : null,
  };
}

export const gatherInputs = internalQuery({
  args: { advertiserId: v.id("advertisers") },
  returns: v.union(knowledgeInputs, v.null()),
  handler: async (ctx, args) => await gather(ctx, args.advertiserId),
});

/** Upsert the company's card. */
export const saveCard = internalMutation({
  args: {
    advertiserId: v.id("advertisers"),
    summary: v.string(),
    category: v.string(),
    stage: companyStage,
    audienceTags: v.record(v.string(), v.number()),
    sources: v.array(v.string()),
    videoTitles: v.array(v.string()),
    method: knowledgeMethod,
    model: v.optional(v.string()),
  },
  returns: v.id("knowledgeCards"),
  handler: async (ctx, args) => {
    const fields = {
      advertiserId: args.advertiserId,
      summary: args.summary.slice(0, 1000),
      category: args.category.slice(0, 40),
      stage: args.stage,
      audienceTags: args.audienceTags,
      sources: args.sources.slice(0, 12),
      videoTitles: args.videoTitles.slice(0, MAX_VIDEOS).map((t) => t.slice(0, 200)),
      method: args.method,
      model: args.model,
      updatedAt: Date.now(),
    };
    const existing = await ctx.db
      .query("knowledgeCards")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", args.advertiserId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("knowledgeCards", fields);
  },
});

/**
 * Build (or rebuild) a company's knowledge card. Claude when configured
 * (runs in the Node runtime, see knowledgeNode.ts), else the heuristic.
 */
export const buildForCompany = internalAction({
  args: { advertiserId: v.id("advertisers"), reason: v.optional(v.string()) },
  returns: v.union(v.null(), v.object({ method: knowledgeMethod, category: v.string() })),
  handler: async (ctx, args): Promise<{ method: "claude" | "heuristic"; category: string } | null> => {
    const inputs: KnowledgeInputs | null = await ctx.runQuery(internal.knowledge.gatherInputs, { advertiserId: args.advertiserId });
    if (!inputs) return null;
    const heuristic = heuristicCard(inputs);
    const videoTitles = inputs.videos.map((v) => v.title);
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const result = await ctx.runAction(internal.knowledgeNode.generateCard, { inputs });
        if (result) {
          await ctx.runMutation(internal.knowledge.saveCard, {
            advertiserId: args.advertiserId,
            ...result.card,
            sources: [...new Set([...sourcesFrom(inputs), ...result.sources])].slice(0, 12),
            videoTitles,
            method: "claude",
            model: result.model,
          });
          return { method: "claude", category: result.card.category };
        }
      } catch (error) {
        console.warn(`Knowledge card via Claude failed for ${args.advertiserId}, using heuristic:`, error);
      }
    }
    await ctx.runMutation(internal.knowledge.saveCard, {
      advertiserId: args.advertiserId,
      ...heuristic,
      sources: sourcesFrom(inputs),
      videoTitles,
      method: "heuristic",
    });
    return { method: "heuristic", category: heuristic.category };
  },
});

const cardView = v.object({
  advertiserId: v.id("advertisers"),
  displayName: v.string(),
  summary: v.string(),
  category: v.string(),
  stage: companyStage,
  method: knowledgeMethod,
  updatedAt: v.number(),
  /** Detail: only for the company's members and for hosts; null otherwise. */
  audienceTags: v.union(v.record(v.string(), v.number()), v.null()),
  sources: v.union(v.array(v.string()), v.null()),
  videoTitles: v.union(v.array(v.string()), v.null()),
});

type Viewer = { isHost: boolean; companies: Set<Id<"advertisers">> };

async function viewerOf(ctx: QueryCtx): Promise<Viewer> {
  const user = await requireUser(ctx);
  const host = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", user.userId))
    .first();
  const memberships = await ctx.db
    .query("advertiserMembers")
    .withIndex("by_user", (q) => q.eq("userId", user.userId))
    .take(20);
  return { isHost: host !== null, companies: new Set(memberships.map((m) => m.advertiserId)) };
}

async function toView(ctx: QueryCtx, card: Doc<"knowledgeCards">, viewer: Viewer) {
  const detail = viewer.isHost || viewer.companies.has(card.advertiserId);
  return {
    advertiserId: card.advertiserId,
    displayName: (await ctx.db.get(card.advertiserId))?.displayName ?? "Unknown company",
    summary: card.summary,
    category: card.category,
    stage: card.stage,
    method: card.method,
    updatedAt: card.updatedAt,
    audienceTags: detail ? card.audienceTags : null,
    sources: detail ? card.sources : null,
    videoTitles: detail ? card.videoTitles : null,
  };
}

/** Full-text search over company summaries (max 10). Signed-in accounts only; see visibility above. */
export const search = query({
  args: { q: v.string(), category: v.optional(v.string()) },
  returns: v.array(cardView),
  handler: async (ctx, args) => {
    const viewer = await viewerOf(ctx);
    const q = args.q.trim().slice(0, MAX_QUERY_LENGTH);
    if (q.length === 0) return [];
    const category = args.category?.trim().toLowerCase().slice(0, 40);
    const cards = await ctx.db
      .query("knowledgeCards")
      .withSearchIndex("search_summary", (s) => (category ? s.search("summary", q).eq("category", category) : s.search("summary", q)))
      .take(MAX_SEARCH_RESULTS);
    const out = [];
    for (const card of cards) out.push(await toView(ctx, card, viewer));
    return out;
  },
});

/** One company's card (null until built). Signed-in accounts only; see visibility above. */
export const forCompany = query({
  args: { advertiserId: v.id("advertisers") },
  returns: v.union(cardView, v.null()),
  handler: async (ctx, args) => {
    const viewer = await viewerOf(ctx);
    const card = await ctx.db
      .query("knowledgeCards")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", args.advertiserId))
      .unique();
    return card ? await toView(ctx, card, viewer) : null;
  },
});

/** A company member asks for a fresh card now (debounced). Returns false for non-members. */
export const refresh = mutation({
  args: { advertiserId: v.id("advertisers") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const viewer = await viewerOf(ctx);
    if (!viewer.companies.has(args.advertiserId)) return false;
    return await requestKnowledgeBuild(ctx, args.advertiserId, "refresh requested by the company");
  },
});
