import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, signedInCustomer, signedInOperator, signedInUser } from "./test.setup";
import { heuristicCard, mergeAudiences, parseCard, sourcesFrom, type KnowledgeInputs } from "./knowledgeRules";

const START = Date.UTC(2026, 9, 25, 16, 7);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code: string }).code;
    throw error;
  }
  throw new Error("expected promise to reject");
}

const SECRET_BRIEF = "Spend our secret 9000 dollar budget on founders and engineers near Moscone for our API launch";

const base: KnowledgeInputs = {
  displayName: "LaunchKit",
  website: "https://www.launchkit.dev",
  size: null,
  briefs: [SECRET_BRIEF],
  targetAudiences: [{ software: 0.6, startups: 0.4 }],
  videos: [{ title: "Ship your API in a weekend", author: "LaunchKit", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }],
  research: null,
};

describe("knowledge rules", () => {
  test("heuristic card: category, stage, audience; the public summary never quotes the brief", () => {
    const card = heuristicCard(base);
    expect(card.category).toBe("developer tools");
    expect(card.stage).toBe("startup");
    expect(card.audienceTags).toEqual({ software: 0.6, startups: 0.4 });
    expect(card.summary).toContain("LaunchKit is a startup developer tools company (launchkit.dev).");
    expect(card.summary).toContain('"Ship your API in a weekend"');
    expect(card.summary).not.toMatch(/secret|9000|budget/i);
  });

  test("research stage wins; size maps to stage; no audience falls back to the category's", () => {
    expect(heuristicCard({ ...base, research: { brandTier: "growth", reasoning: "", sources: [], method: "claude" } }).stage).toBe("growth");
    expect(heuristicCard({ ...base, briefs: [], videos: [], size: "1000+" }).stage).toBe("enterprise");
    const coffee = heuristicCard({ ...base, displayName: "Bean There", website: null, briefs: ["Fresh coffee and pastries"], targetAudiences: [], videos: [] });
    expect(coffee.category).toBe("food & beverage");
    expect(coffee.audienceTags).toEqual({ office: 0.4, tourists: 0.3, families: 0.3 });
    expect(heuristicCard({ ...base, displayName: "Zzz", website: null, briefs: [], videos: [], targetAudiences: [] }).category).toBe("general");
  });

  test("mergeAudiences averages normalised campaign targets", () => {
    expect(mergeAudiences([{ software: 1 }, { software: 1, students: 1 }])).toEqual({ software: 0.75, students: 0.25 });
    expect(mergeAudiences([{ "BAD KEY": 1 }])).toEqual({});
  });

  test("parseCard validates untrusted model output", () => {
    expect(parseCard({ summary: "LaunchKit builds APIs.", category: "developer tools", stage: "startup", audience: [{ tag: "software", weight: 1 }, { tag: "hackers", weight: 1 }] })).toEqual({
      summary: "LaunchKit builds APIs.",
      category: "developer tools",
      stage: "startup",
      audienceTags: { software: 1 },
    });
    expect(parseCard({ summary: "LaunchKit builds APIs.", category: "nonsense", stage: "seed", audience: "x" })).toMatchObject({ category: "general", stage: "unknown", audienceTags: {} });
    expect(parseCard({ summary: "short" })).toBeNull();
    expect(parseCard(null)).toBeNull();
  });

  test("sources: website, research URLs and videos, http(s) only", () => {
    expect(sourcesFrom({ ...base, research: { brandTier: "startup", reasoning: "", sources: ["https://news.test/a", "javascript:x"], method: "claude" } })).toEqual([
      "https://www.launchkit.dev",
      "https://news.test/a",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]);
  });
});

async function world() {
  const t = convexTest(schema, modules);
  const host = await signedInOperator(t, "host@venue.test");
  const launchKit = await t.run(async (ctx) =>
    ctx.db.insert("advertisers", { displayName: "LaunchKit", paymentTerms: "prepay", website: "https://launchkit.dev", size: "1-10" }),
  );
  const rivet = await t.run(async (ctx) => ctx.db.insert("advertisers", { displayName: "Rivet", paymentTerms: "prepay" }));
  const lkCustomer = await signedInCustomer(t, launchKit, "buyer@launchkit.test");
  const rivetCustomer = await signedInCustomer(t, rivet, "buyer@rivet.test");
  await t.run(async (ctx) =>
    ctx.db.insert("campaigns", {
      advertiserId: launchKit,
      brief: SECRET_BRIEF,
      budgetMinor: 900_000,
      currency: "USD",
      status: "active",
      creativeStatus: "none",
      targetAudience: { software: 0.7, startups: 0.3 },
    }),
  );
  return { t, host, launchKit, rivet, lkCustomer, rivetCustomer };
}

describe("knowledge.buildForCompany + search", () => {
  test("builds a heuristic card, reusing the company analyst's research", async () => {
    const { t, launchKit, lkCustomer } = await world();
    await t.run(async (ctx) =>
      ctx.db.insert("companyAssessments", {
        advertiserId: launchKit,
        multiplier: 0.9,
        brandTier: "growth",
        reasoning: "Seed-funded developer platform.",
        sources: ["https://news.test/launchkit-raises"],
        confidence: 0.7,
        method: "claude",
        inputsSummary: "x",
        assessedAt: START,
        expiresAt: START + 86_400_000,
      }),
    );
    const r = await t.action(internal.knowledge.buildForCompany, { advertiserId: launchKit });
    expect(r).toEqual({ method: "heuristic", category: "developer tools" });
    const card = await lkCustomer.query(api.knowledge.forCompany, { advertiserId: launchKit });
    expect(card).toMatchObject({
      displayName: "LaunchKit",
      category: "developer tools",
      stage: "growth",
      method: "heuristic",
      audienceTags: { software: 0.7, startups: 0.3 },
    });
    expect(card?.sources).toEqual(["https://launchkit.dev", "https://news.test/launchkit-raises"]);
    expect(card?.summary).not.toMatch(/secret|9000|budget/i);

    // Rebuild upserts (one card per company).
    await t.action(internal.knowledge.buildForCompany, { advertiserId: launchKit });
    expect(await t.run(async (ctx) => (await ctx.db.query("knowledgeCards").take(10)).length)).toBe(1);
  });

  test("search: public summary for everyone signed in; detail only for the company and hosts", async () => {
    const { t, host, launchKit, rivet, lkCustomer, rivetCustomer } = await world();
    await t.action(internal.knowledge.buildForCompany, { advertiserId: launchKit });
    await t.action(internal.knowledge.buildForCompany, { advertiserId: rivet });

    const mine = await lkCustomer.query(api.knowledge.search, { q: "developer tools" });
    expect(mine.map((c) => c.displayName)).toEqual(["LaunchKit"]);
    expect(mine[0].audienceTags).toEqual({ software: 0.7, startups: 0.3 });

    // A competitor sees the public part only.
    const theirs = await rivetCustomer.query(api.knowledge.search, { q: "LaunchKit" });
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ displayName: "LaunchKit", category: "developer tools", audienceTags: null, sources: null, videoTitles: null });
    expect(await rivetCustomer.query(api.knowledge.forCompany, { advertiserId: launchKit })).toMatchObject({ audienceTags: null });

    // Hosts target with it.
    const hostView = await host.query(api.knowledge.search, { q: "LaunchKit", category: "developer tools" });
    expect(hostView[0].audienceTags).toEqual({ software: 0.7, startups: 0.3 });
    expect(await host.query(api.knowledge.search, { q: "LaunchKit", category: "fintech" })).toEqual([]);

    expect(await lkCustomer.query(api.knowledge.search, { q: "   " })).toEqual([]);
    const someone = await signedInUser(t);
    expect((await someone.query(api.knowledge.search, { q: "LaunchKit" }))[0].audienceTags).toBeNull();
    expect(await errorCode(t.query(api.knowledge.search, { q: "LaunchKit" }))).toBe("UNAUTHENTICATED");
    expect(await errorCode(t.query(api.knowledge.forCompany, { advertiserId: launchKit }))).toBe("UNAUTHENTICATED");
  });

  test("requests are debounced; only members can refresh their own card", async () => {
    const { t, launchKit, rivet, lkCustomer, rivetCustomer } = await world();
    expect(await t.mutation(internal.knowledge.requestBuild, { advertiserId: launchKit, reason: "company created" })).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.mutation(internal.knowledge.requestBuild, { advertiserId: launchKit, reason: "again" })).toBe(true);
    expect(await t.mutation(internal.knowledge.requestBuild, { advertiserId: launchKit, reason: "again" })).toBe(false);
    expect(await rivetCustomer.mutation(api.knowledge.refresh, { advertiserId: launchKit })).toBe(false);
    vi.advanceTimersByTime(31_000);
    expect(await lkCustomer.mutation(api.knowledge.refresh, { advertiserId: launchKit })).toBe(true);
    expect(await t.action(internal.knowledge.buildForCompany, { advertiserId: rivet as Id<"advertisers"> })).toMatchObject({ method: "heuristic" });
  });
});

describe("the ad video drives the profile (ICP)", () => {
  test("heuristic: the video's description and keywords set the category; a placeholder brief doesn't", () => {
    const card = heuristicCard({
      ...base,
      displayName: "Bean There",
      website: null,
      briefs: [],
      targetAudiences: [],
      videos: [
        {
          title: "Our new spring menu",
          author: "Bean There",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          description: "Fresh coffee, pastries and brunch at our three cafes.",
          keywords: ["coffee", "cafe"],
        },
      ],
    });
    expect(card.category).toBe("food & beverage");
    expect(Object.keys(card.audienceTags).length).toBeGreaterThan(0);
  });

  test("a video-led campaign takes the card's audience; an advertiser-picked one keeps its own", async () => {
    const { t, launchKit } = await world();
    const [videoLed, picked] = await t.run(async (ctx) => {
      const common = { advertiserId: launchKit, budgetMinor: 5000, currency: "USD" as const, status: "active" as const, creativeStatus: "none" as const };
      return [
        await ctx.db.insert("campaigns", { ...common, brief: "YouTube ad", targetAudience: { tourists: 1 }, audienceSource: "video" as const }),
        await ctx.db.insert("campaigns", { ...common, brief: "Picked", targetAudience: { families: 1 } }),
      ];
    });
    await t.mutation(internal.knowledge.saveCard, {
      advertiserId: launchKit,
      summary: "LaunchKit is a developer tools startup.",
      category: "developer tools",
      stage: "startup",
      audienceTags: { software: 0.6, startups: 0.4 },
      sources: [],
      videoTitles: [],
      method: "claude",
    });
    const after = await t.run(async (ctx) => [await ctx.db.get(videoLed), await ctx.db.get(picked)]);
    expect(after[0]?.targetAudience).toEqual({ software: 0.6, startups: 0.4 });
    expect(after[1]?.targetAudience).toEqual({ families: 1 });
  });

  test("a forced request skips the debounce (a new video must not wait 30 s)", async () => {
    const { t, launchKit } = await world();
    expect(await t.mutation(internal.knowledge.requestBuild, { advertiserId: launchKit, reason: "company created" })).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.mutation(internal.knowledge.requestBuild, { advertiserId: launchKit, reason: "again" })).toBe(true);
    expect(await t.mutation(internal.knowledge.requestBuild, { advertiserId: launchKit, reason: "video", force: true })).toBe(true);
  });
});
