import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { env, internalAction, internalMutation } from "./_generated/server";
import { embedTexts, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./lib/bitdeerEmbedding";

export const save = internalMutation({
  args: {
    passageId: v.id("companyKnowledgePassages"), contentHash: v.string(),
    vector: v.array(v.float64()), model: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, { passageId, contentHash, vector, model }) => {
    if (model !== EMBEDDING_MODEL || vector.length !== EMBEDDING_DIMENSIONS ||
      !vector.every(Number.isFinite)) throw new Error("Invalid embedding vector");
    const passage = await ctx.db.get(passageId);
    if (!passage?.active || passage.contentHash !== contentHash) return false;
    await ctx.db.patch(passageId, { embedding: vector, embeddingStatus: "ready", embeddingModel: model,
      embeddingHash: contentHash, embeddedAt: Date.now() });
    return true;
  },
});

export const indexMissing = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ status: v.union(v.literal("ok"), v.literal("missing_key"), v.literal("failed")), embedded: v.number(), failed: v.number(), remaining: v.number(), error: v.optional(v.string()) }),
  handler: async (ctx, { limit }): Promise<{ status: "ok" | "missing_key" | "failed"; embedded: number; failed: number; remaining: number; error?: string }> => {
    const count = Math.max(1, Math.min(Math.floor(limit ?? 16), 16));
    const pending: Doc<"companyKnowledgePassages">[] = await ctx.runQuery(internal.companyKnowledge.missingEmbeddings, { limit: count });
    if (!env.BITDEER_API_KEY) return { status: "missing_key" as const, embedded: 0, failed: 0, remaining: pending.length };
    if (!pending.length) return { status: "ok" as const, embedded: 0, failed: 0, remaining: 0 };
    try {
      const vectors = await embedTexts(pending.map((p) => `${p.title}\n${p.text}`), env.BITDEER_API_KEY);
      let embedded = 0;
      for (let i = 0; i < pending.length; i++) {
        if (await ctx.runMutation(internal.companyKnowledgeEmbedding.save, {
          passageId: pending[i]._id, contentHash: pending[i].contentHash,
          vector: vectors[i], model: EMBEDDING_MODEL,
        })) embedded++;
      }
      const remaining: Doc<"companyKnowledgePassages">[] = await ctx.runQuery(internal.companyKnowledge.missingEmbeddings, { limit: 16 });
      return { status: "ok" as const, embedded, failed: pending.length - embedded, remaining: remaining.length };
    } catch (error) {
      return { status: "failed" as const, embedded: 0, failed: pending.length,
        remaining: pending.length, error: error instanceof Error ? error.message : "Embedding failed" };
    }
  },
});
