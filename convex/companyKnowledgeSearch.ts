import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, internalAction, type ActionCtx } from "./_generated/server";
import { embedTexts } from "./lib/bitdeerEmbedding";

type SearchInput = { query: string; advertiserId?: Id<"advertisers">; limit: number };
type Citation = { title: string; url: string; text: string; sourceKind: string; verifiedAt: number };
type Card = { summary: string; category: string; stage: string; audienceTags: Record<string, number>; sources: string[]; videoTitles: string[]; method: string; derivedFieldsNote?: string } | null;
type Hit = Citation & { passageId: Id<"companyKnowledgePassages">; advertiserId: Id<"advertisers">; score: number };
type SearchResult = { status: "missing_key" | "ok" | "empty_index"; hits: Hit[] };
type HydratedPassage = Pick<Doc<"companyKnowledgePassages">, "_id" | "advertiserId" | "title" | "url" | "text" | "sourceKind" | "verifiedAt">;

async function retrieve(ctx: ActionCtx, input: SearchInput): Promise<SearchResult> {
  if (!input.query.trim() || input.query.length > 500) throw new Error("Search query must be 1-500 characters");
  if (!env.BITDEER_API_KEY) return { status: "missing_key" as const, hits: [] };
  const [vector] = await embedTexts([input.query], env.BITDEER_API_KEY);
  const matches = await ctx.vectorSearch("companyKnowledgePassages", "by_embedding", {
    vector,
    limit: Math.min(16, input.limit * 2),
    ...(input.advertiserId ? { filter: (q) => q.eq("advertiserId", input.advertiserId!) } : {}),
  });
  const rows: HydratedPassage[] = await ctx.runQuery(internal.companyKnowledge.hydrate, { ids: matches.map((m) => m._id) });
  const byId = new Map<Id<"companyKnowledgePassages">, HydratedPassage>(rows.map((row) => [row._id, row]));
  const hits: Hit[] = matches.flatMap((match): Hit[] => {
    const row = byId.get(match._id);
    return row && (!input.advertiserId || row.advertiserId === input.advertiserId)
      ? [{ passageId: row._id, advertiserId: row.advertiserId, score: match._score,
        title: row.title, url: row.url, text: row.text, sourceKind: row.sourceKind,
        verifiedAt: row.verifiedAt }]
      : [];
  }).slice(0, input.limit);
  return { status: hits.length ? "ok" as const : "empty_index" as const, hits };
}

export const search = internalAction({
  args: { query: v.string(), advertiserId: v.optional(v.id("advertisers")), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args): Promise<SearchResult> => retrieve(ctx, { query: args.query, advertiserId: args.advertiserId,
    limit: Math.max(1, Math.min(Math.floor(args.limit ?? 8), 8)) }),
});

export const agentContext = internalAction({
  args: { advertiserId: v.id("advertisers"), question: v.string() },
  returns: v.any(),
  handler: async (ctx, { advertiserId, question }): Promise<{ advertiserId: Id<"advertisers">; card: Card; research: unknown; retrievalStatus: SearchResult["status"]; citations: Citation[]; provenance: string }> => {
    const structured: { card: Card; research: unknown; passages: Citation[] } = await ctx.runQuery(internal.companyKnowledge.context, { advertiserId });
    const result = await retrieve(ctx, { query: question, advertiserId, limit: 5 });
    const fallback = structured.passages.slice(0, 5);
    return {
      advertiserId, card: structured.card, research: structured.research,
      retrievalStatus: result.status,
      citations: result.hits.length ? result.hits.map(({ title, url, text, sourceKind, verifiedAt }) =>
        ({ title, url, text, sourceKind, verifiedAt })) : fallback,
      provenance: "Public company sources; sponsor campaign and payment data are simulated and excluded.",
    };
  },
});
