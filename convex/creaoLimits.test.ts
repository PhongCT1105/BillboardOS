/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";
import { creaoRetryAfterMs } from "./creaoLimits";

describe("creaoRetryAfterMs", () => {
  test("our start budget: waits what the limiter says, at least a minute", () => {
    expect(creaoRetryAfterMs(new Error("Uncaught Error: CREAO rate-limited for 81306.99999999994ms"))).toBe(81_307);
    expect(creaoRetryAfterMs(new Error("CREAO rate-limited for 500ms"))).toBe(60_000);
    expect(creaoRetryAfterMs(new Error("CREAO rate-limited"))).toBe(60_000);
  });

  test("CREAO's own HTTP 429 waits two minutes", () => {
    expect(creaoRetryAfterMs(new Error("CREAO returned HTTP 429"))).toBe(120_000);
  });

  test("other failures are not retried as busy", () => {
    expect(creaoRetryAfterMs(new Error("CREAO returned HTTP 500"))).toBeNull();
    expect(creaoRetryAfterMs(new Error("CREAO price_refine result failed validation"))).toBeNull();
  });
});

describe("saveResearch", () => {
  const research = {
    summary: "Real research.",
    category: "software",
    audienceTags: { software: 1 },
    reasoning: "From CREAO.",
    sources: [],
  };

  test("a rules placeholder never overwrites agent research", async () => {
    const t = convexTest(schema, modules);
    const advertiserId = await t.run((ctx) => ctx.db.insert("advertisers", { displayName: "Acme", paymentTerms: "prepay" }));
    await t.mutation(internal.research.saveResearch, { advertiserId, ...research, priceFactor: 1.3, method: "creao" });
    await t.mutation(internal.research.saveResearch, {
      advertiserId,
      ...research,
      summary: "Acme (not researched yet).",
      priceFactor: 1,
      method: "rules",
    });
    const row = await t.run((ctx) => ctx.db.query("companyResearch").unique());
    expect(row).toMatchObject({ method: "creao", priceFactor: 1.3, summary: "Real research." });
  });

  test("rules still bootstraps a company with no research, and agent research replaces it", async () => {
    const t = convexTest(schema, modules);
    const advertiserId = await t.run((ctx) => ctx.db.insert("advertisers", { displayName: "Acme", paymentTerms: "prepay" }));
    await t.mutation(internal.research.saveResearch, { advertiserId, ...research, priceFactor: 1, method: "rules" });
    expect(await t.run((ctx) => ctx.db.query("companyResearch").unique())).toMatchObject({ method: "rules" });
    await t.mutation(internal.research.saveResearch, { advertiserId, ...research, priceFactor: 1.2, method: "creao" });
    expect(await t.run((ctx) => ctx.db.query("companyResearch").unique())).toMatchObject({ method: "creao", priceFactor: 1.2 });
  });
});
