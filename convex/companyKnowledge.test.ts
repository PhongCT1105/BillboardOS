import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";
import { COMPANY_KNOWLEDGE } from "./fixtures/companyKnowledge";
import { SPONSORS } from "./fixtures/sponsors";
import { registerBackendComponents } from "./test.setup";

beforeEach(() => {
  process.env.INTERNAL_API_SECRET = "test-internal-secret-0123456789";
  process.env.CONVEX_SITE_URL = "https://site.test";
});
afterEach(() => {
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.CONVEX_SITE_URL;
});

describe("company knowledge pipeline", () => {
  test("curates source-backed profiles for the full sponsor network and seeds them idempotently", async () => {
    expect(COMPANY_KNOWLEDGE).toHaveLength(SPONSORS.length);
    expect(new Set(COMPANY_KNOWLEDGE.map((p) => p.name)).size).toBe(SPONSORS.length);
    expect(COMPANY_KNOWLEDGE.every((p) => p.passages.length >= 2 && p.passages.every((s) => s.url.startsWith("https://")))).toBe(true);
    const t = convexTest(schema, modules);
    registerBackendComponents(t);
    await t.mutation(internal.sponsors.seed, {});
    const first = await t.mutation(internal.companyKnowledge.seedSponsors, {});
    const second = await t.mutation(internal.companyKnowledge.seedSponsors, {});
    expect(first.profiles).toBe(SPONSORS.length);
    expect(first.passages).toBe(SPONSORS.length * 3);
    expect(second.changed).toBe(0);
    const counts = await t.run(async (ctx) => ({
      cards: await ctx.db.query("knowledgeCards").take(SPONSORS.length + 5),
      passages: await ctx.db.query("companyKnowledgePassages").take(SPONSORS.length * 3 + 5),
    }));
    expect(counts.cards).toHaveLength(SPONSORS.length);
    expect(counts.passages).toHaveLength(SPONSORS.length * 3);
  });

  test("rejects an embedding result for a superseded passage", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => ctx.db.insert("advertisers", { displayName: "CREAO", paymentTerms: "prepay" }));
    await t.mutation(internal.companyKnowledge.seedSponsors, {});
    const passage = await t.run(async (ctx) => (await ctx.db.query("companyKnowledgePassages").first())!);
    const saved = await t.mutation(internal.companyKnowledgeEmbedding.save, {
      passageId: passage._id, contentHash: "outdated", vector: Array(1024).fill(0), model: "BAAI/bge-m3",
    });
    expect(saved).toBe(false);
    const after = await t.run(async (ctx) => ctx.db.get(passage._id));
    expect(after?.embedding).toBeUndefined();
  });

  test("a changed passage loses its old vector and unrelated cards survive", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => ({
      sponsor: await ctx.db.insert("advertisers", { displayName: "CREAO", paymentTerms: "prepay" }),
      unrelated: await ctx.db.insert("advertisers", { displayName: "Other Co", paymentTerms: "prepay" }),
    }));
    await t.run(async (ctx) => ctx.db.insert("knowledgeCards", {
      advertiserId: ids.unrelated, summary: "Untouched", category: "other", stage: "unknown",
      audienceTags: {}, sources: [], videoTitles: [], method: "heuristic", updatedAt: 1,
    }));
    await t.mutation(internal.companyKnowledge.seedSponsors, {});
    const passage = await t.run(async (ctx) => ctx.db.query("companyKnowledgePassages")
      .withIndex("by_advertiser_and_passageKey", (q) => q.eq("advertiserId", ids.sponsor).eq("passageKey", "overview")).first());
    expect(passage).not.toBeNull();
    await t.mutation(internal.companyKnowledgeEmbedding.save, {
      passageId: passage!._id, contentHash: passage!.contentHash,
      vector: Array(1024).fill(0.1), model: "BAAI/bge-m3",
    });
    await t.run(async (ctx) => ctx.db.patch(passage!._id, { contentHash: "superseded" }));
    expect((await t.mutation(internal.companyKnowledge.seedSponsors, {})).changed).toBe(1);
    const after = await t.run(async (ctx) => ({ passage: await ctx.db.get(passage!._id),
      unrelated: await ctx.db.query("knowledgeCards").withIndex("by_advertiser", (q) => q.eq("advertiserId", ids.unrelated)).first() }));
    expect(after.passage?.embedding).toBeUndefined();
    expect(after.passage?.embeddingStatus).toBe("pending");
    expect(after.unrelated?.summary).toBe("Untouched");
  });
});
