import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

describe("company knowledge retrieval", () => {
  test("returns cited company context when embeddings are unavailable", async () => {
    const t = convexTest(schema, modules);
    const advertiserId = await t.run(async (ctx) => ctx.db.insert("advertisers", { displayName: "CREAO", paymentTerms: "prepay" }));
    await t.mutation(internal.companyKnowledge.seedSponsors, {});
    const result = await t.action(internal.companyKnowledgeSearch.agentContext, {
      advertiserId, question: "What does CREAO offer?",
    });
    expect(result.retrievalStatus).toBe("missing_key");
    expect(result.card?.category).toBe("ai agent platform");
    expect(result.citations).toHaveLength(3);
    expect(result.citations[0].url).toMatch(/^https:\/\//);
  });
});
