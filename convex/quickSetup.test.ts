import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules, signedInCustomer, signedInOperator, type TestClient } from "./test.setup";
import { creativeReady } from "./lib/sale";

/**
 * The marketer's whole setup (ADR 0007, demo flow): paste the ad video, pick a
 * daily limit. We read the video, name the company after the channel, the
 * research agent reads the company, and the agent answers offers with it.
 */

const START = Date.UTC(2026, 9, 25, 16, 7);
const ID = "dQw4w9WgXcQ";
const OTHER = "9bZkp7q19f0";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://www.youtube.com/oembed")) {
        return Response.json({
          type: "video",
          provider_name: "YouTube",
          title: "Our new spring menu",
          author_name: "Bean There",
          author_url: "https://www.youtube.com/@beanthere",
          thumbnail_url: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
        });
      }
      if (url.startsWith("https://www.youtube.com/watch")) {
        return new Response(
          `<script>var ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"Fresh coffee, pastries and brunch at our cafes.","keywords":["coffee","cafe"]}};</script>`,
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.CONVEX_SITE_URL;
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

async function flush(t: TestClient) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** A host, and a company named automatically at sign-up with its starter campaign (as AutoSetup makes them). */
async function world() {
  const t = convexTest(schema, modules);
  await signedInOperator(t, "host@venue.test");
  const workspaceId = await t.run(async (ctx) => (await ctx.db.query("workspaces").first())!._id);
  const advertiserId = await t.run(async (ctx) =>
    ctx.db.insert("advertisers", { displayName: "Summit Health 393", paymentTerms: "prepay", autoNamed: true }),
  );
  const customer = await signedInCustomer(t, advertiserId, "marketer@beanthere.test");
  const campaignId = await customer.mutation(api.campaigns.create, {
    brief: "Launch campaign for Summit Health 393: reach founders and engineers near San Francisco",
    budgetMinor: 5000,
    targetAudience: { startups: 0.6, software: 0.4 },
  });
  return { t, workspaceId, advertiserId, customer, campaignId };
}

describe("companyAgents.quickSetup", () => {
  test("video + daily limit: limits derived, video read, company named and researched, ad ready to sell", async () => {
    const { t, workspaceId, advertiserId, customer, campaignId } = await world();
    const r = await customer.mutation(api.companyAgents.quickSetup, { videoUrl: `https://youtu.be/${ID}`, dailyBudgetMinor: 500 });
    expect(r.campaignId).toBe(campaignId);

    const key = await t.run(async (ctx) => ctx.db.query("agentKeys").first());
    expect(key?.standing).toEqual({ maxPricePerSpotMinor: 150, minRelevantViewers: 1, dailyBudgetMinor: 500 });
    expect((await t.run(async (ctx) => ctx.db.get(campaignId)))?.audienceSource).toBe("video");

    await flush(t);

    const company = await t.run(async (ctx) => ctx.db.get(advertiserId));
    expect(company).toMatchObject({ displayName: "Bean There", autoNamed: false });
    const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
    expect(campaign?.brief).toBe('YouTube ad "Our new spring menu" by Bean There');

    const mine = await customer.query(api.companyAgents.mine, {});
    expect(mine?.video).toMatchObject({
      videoId: ID,
      title: "Our new spring menu",
      author: "Bean There",
      description: "Fresh coffee, pastries and brunch at our cafes.",
      status: "ok",
    });
    // No Claude key in tests: the research agent falls back to rules (average price, the campaign's audience).
    expect(mine?.profile).toMatchObject({ method: "rules", priceFactor: 1 });

    expect(await t.run(async (ctx) => creativeReady(ctx, (await ctx.db.get(campaignId))!, workspaceId))).toBe(true);
  });

  test("saving again with the same video keeps its approval; a new video replaces it", async () => {
    const { t, customer, campaignId } = await world();
    await customer.mutation(api.companyAgents.quickSetup, { videoUrl: `https://youtu.be/${ID}`, dailyBudgetMinor: 500 });
    await flush(t);
    const approvals = async () => (await t.run(async (ctx) => ctx.db.query("creativeApprovals").take(10))).length;
    expect(await approvals()).toBe(1);

    await customer.mutation(api.companyAgents.quickSetup, { videoUrl: `https://www.youtube.com/watch?v=${ID}`, dailyBudgetMinor: 1000 });
    expect(await approvals()).toBe(1);
    const key = await t.run(async (ctx) => (await ctx.db.query("agentKeys").order("desc").first())!);
    expect(key.standing?.dailyBudgetMinor).toBe(1000);

    await customer.mutation(api.companyAgents.quickSetup, { videoUrl: `https://youtu.be/${OTHER}`, dailyBudgetMinor: 1000 });
    expect(await approvals()).toBe(0);
    expect((await customer.query(api.companyAgents.mine, {}))?.video).toMatchObject({ videoId: OTHER, status: "pending" });
    expect((await t.run(async (ctx) => ctx.db.get(campaignId)))?.creativeContentType).toBe("youtube");
  });

  test("bad links and budgets off the slider are refused", async () => {
    const { customer } = await world();
    expect(await errorCode(customer.mutation(api.companyAgents.quickSetup, { videoUrl: "https://vimeo.com/1", dailyBudgetMinor: 500 }))).toBe(
      "INVALID_INPUT",
    );
    expect(await errorCode(customer.mutation(api.companyAgents.quickSetup, { videoUrl: `https://youtu.be/${ID}`, dailyBudgetMinor: 50 }))).toBe(
      "INVALID_INPUT",
    );
    expect(await errorCode(customer.mutation(api.companyAgents.quickSetup, { videoUrl: `https://youtu.be/${ID}`, dailyBudgetMinor: 525 }))).toBe(
      "INVALID_INPUT",
    );
  });
});
