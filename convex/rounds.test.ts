/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, signedInCustomer, signedInOperator, type TestClient } from "./test.setup";
import { ensureUpcomingSlots } from "./lib/inventory";
import { closeRoundCore, startRoundCore } from "./rounds";
import { ruleBasedStrategy } from "./lib/rounds";

// Sunday 2026-10-25, 09:07 PDT: the 09:00-09:15 slot is on air with 8 minutes left.
const START = Date.UTC(2026, 9, 25, 16, 7);
const SITE = "https://site.test";
const SECRET = "test-internal-secret-0123456789";
const STANDING = { maxPricePerSpotMinor: 500, minRelevantViewers: 3, dailyBudgetMinor: 1000 };

let current: TestClient | null = null;
let webhooks: { url: string; event: string | null; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  process.env.INTERNAL_API_SECRET = SECRET;
  process.env.CONVEX_SITE_URL = SITE;
  webhooks = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(SITE) && current) return await current.fetch(url.slice(SITE.length), init);
      if (url.startsWith("https://agent.test/")) {
        const headers = new Headers(init?.headers);
        webhooks.push({ url, event: headers.get("X-BillboardOS-Event"), body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response("ok", { status: 200 });
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
  current = null;
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

/**
 * A host with screen "LED" (floor $1.00) and the named companies, each with an
 * active campaign whose ad the host approved, and an agent key (hold, pay,
 * bid) with a webhook and standing limits.
 */
async function world(opts: { companies?: string[]; screenTags?: Record<string, number> | null } = {}) {
  const t = convexTest(schema, modules);
  current = t;
  const host = await signedInOperator(t, "host@venue.test");
  const workspaceId = await t.run(async (ctx) => (await ctx.db.query("workspaces").withIndex("by_name", (q) => q.eq("name", "Moscone Media")).first())!._id);
  const led = await t.run(async (ctx) => {
    const id = await ctx.db.insert("billboards", {
      workspaceId,
      name: "LED",
      city: "San Francisco",
      locationLabel: "LED at the venue",
      utcOffsetMinutes: -420,
      reserveFloorMinor: 100,
      baseRateMinor: 300,
      deviceStatus: "online",
      ...(opts.screenTags === null ? {} : { audienceTags: opts.screenTags ?? { startups: 0.5, software: 0.5 } }),
    });
    await ensureUpcomingSlots(ctx, id, Date.now());
    return id;
  });

  async function addCompany(name: string) {
    const slug = name.toLowerCase();
    const advertiserId = await t.run(async (ctx) => ctx.db.insert("advertisers", { displayName: name, paymentTerms: "prepay" }));
    const campaignId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["<svg/>"], { type: "image/svg+xml" }));
      return await ctx.db.insert("campaigns", {
        advertiserId,
        brief: `${name} launch`,
        budgetMinor: 100_000,
        currency: "USD",
        status: "active",
        creativeStatus: "pending_review",
        creativeStorageId: storageId,
        creativeContentType: "image/svg+xml",
        creativeSubmittedAt: Date.now(),
        targetAudience: { startups: 1 },
      });
    });
    await host.mutation(api.creatives.setReady, { campaignId, ready: true });
    const issued = await t.mutation(internal.agentKeys.issueForCompany, {
      company: name,
      name: `${name} agent`,
      budgetCapMinor: 10_000,
      scopes: ["hold", "pay", "bid"],
    });
    await t.run(async (ctx) => ctx.db.patch(issued.agentKeyId, { webhookUrl: `https://agent.test/${slug}`, standing: STANDING }));
    const customer = await signedInCustomer(t, advertiserId, `buyer@${slug}.test`);
    return { name, advertiserId, campaignId, agentKeyId: issued.agentKeyId, key: issued.key, customer };
  }

  const companies = [];
  for (const name of opts.companies ?? ["LaunchKit", "Rivet"]) companies.push(await addCompany(name));

  const start = (trigger: "camera" | "sell_now" | "timer" = "sell_now") => t.run(async (ctx) => startRoundCore(ctx, led, trigger));
  const round = (id: Id<"rounds">) => t.run(async (ctx) => (await ctx.db.get(id))!);
  const bids = (id: Id<"rounds">) =>
    t.run(async (ctx) =>
      ctx.db
        .query("roundBids")
        .withIndex("by_round", (q) => q.eq("roundId", id))
        .take(20),
    );
  const bid = (c: { key: string }, roundId: Id<"rounds">, amountMinor: number | null, reasoning = "test") =>
    t.mutation(internal.rounds.submitBid, { token: c.key, roundId, amountMinor, reasoning });
  return { t, host, workspaceId, led, companies, addCompany, start, round, bids, bid };
}

describe("rounds: start, invite, bid, close", () => {
  test("S1: two bids, the higher wins and pays the runner-up's bid + 1¢", async () => {
    const w = await world();
    const [lk, rivet] = w.companies;
    const id = (await w.start())!;
    expect(await w.round(id)).toMatchObject({ status: "bidding", floorMinor: 100, askingMinor: 100, invitedCount: 2 });
    await w.bid(lk, id, 300);
    await w.bid(rivet, id, 180);
    const r = await w.round(id);
    const winner = (await w.bids(id)).find((b) => b._id === r.winnerBidId)!;
    expect(r).toMatchObject({ status: "awarded", priceMinor: 181 });
    expect(winner.advertiserId).toBe(lk.advertiserId);
    expect(r.outcome).toMatch(/LaunchKit/);
    expect(r.outcome).toMatch(/Rivet/);
  });

  test("S2: one invited company closes the round as soon as it answers", async () => {
    const w = await world({ companies: ["LaunchKit"] });
    const id = (await w.start())!;
    await w.bid(w.companies[0], id, 150);
    expect(await w.round(id)).toMatchObject({ status: "awarded", priceMinor: 100 });
  });

  test("S3: nobody qualifies: unsold at once, with the reason", async () => {
    const w = await world({ companies: [] });
    const id = (await w.start())!;
    expect(await w.round(id)).toMatchObject({ status: "unsold", invitedCount: 0, outcome: "No company agents with an approved ad and budget." });
  });

  test("S4: everyone passes: unsold, listing each reason", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.bid(w.companies[0], id, null, "Too pricey for us");
    await w.bid(w.companies[1], id, null, "Budget used up");
    const r = await w.round(id);
    expect(r.status).toBe("unsold");
    expect(r.outcome).toMatch(/Too pricey for us/);
    expect(r.outcome).toMatch(/Budget used up/);
  });

  test("S6: a screen without an audience profile still invites, with match unknown", async () => {
    const w = await world({ screenTags: null });
    const id = (await w.start())!;
    expect((await w.bids(id)).map((b) => b.match)).toEqual([null, null]);
    await w.bid(w.companies[0], id, 120);
    await w.bid(w.companies[1], id, null);
    expect((await w.round(id)).status).toBe("awarded");
  });

  test("S7: an agent that never answers doesn't hold the round past 5 s", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.bid(w.companies[1], id, 140);
    expect((await w.round(id)).status).toBe("bidding");
    vi.advanceTimersByTime(5_100);
    await w.t.finishInProgressScheduledFunctions();
    const r = await w.round(id);
    expect(r).toMatchObject({ status: "awarded", priceMinor: 100 });
    expect((await w.bids(id)).find((b) => b._id === r.winnerBidId)?.advertiserId).toBe(w.companies[1].advertiserId);
  });

  test("S10: no second round while one is open", async () => {
    const w = await world();
    expect(await w.start()).not.toBeNull();
    expect(await w.start()).toBeNull();
  });

  test("S11: a bid over the agent's own limit or under the floor is refused; a later valid bid counts", async () => {
    const w = await world();
    const id = (await w.start())!;
    expect(await errorCode(w.bid(w.companies[0], id, 600))).toBe("OVER_LIMIT");
    expect(await errorCode(w.bid(w.companies[0], id, 50))).toBe("BELOW_FLOOR");
    expect(await w.bid(w.companies[0], id, 300)).toEqual({ status: "bid" });
  });

  test("only invited companies can answer", async () => {
    const w = await world();
    const id = (await w.start())!;
    const late = await w.addCompany("Latecomer");
    expect(await errorCode(w.bid(late, id, 200))).toBe("NOT_INVITED");
  });

  test("closing twice changes nothing the second time", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.bid(w.companies[0], id, 200);
    await w.t.run(async (ctx) => closeRoundCore(ctx, id));
    const first = await w.round(id);
    await w.t.run(async (ctx) => closeRoundCore(ctx, id));
    expect(await w.round(id)).toEqual(first);
    expect(first.status).toBe("awarded");
  });

  test("a bid after the round closed is refused", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.bid(w.companies[0], id, 200);
    await w.bid(w.companies[1], id, null);
    expect(await errorCode(w.bid(w.companies[1], id, 300))).toBe("ROUND_CLOSED");
  });
});

/** Run everything scheduled "now", step by step, without jumping the clock. */
async function flush(t: TestClient, rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
  }
}

describe("rounds: agents talk over webhooks and the agent API", () => {
  test("S9: each invited agent gets a signed round_offer and bids over HTTP", async () => {
    const w = await world();
    const [lk, rivet] = w.companies;
    const id = (await w.start())!;
    await flush(w.t);
    const offers = webhooks.filter((h) => h.event === "round_offer");
    expect(offers.map((h) => h.url).sort()).toEqual(["https://agent.test/launchkit", "https://agent.test/rivet"]);
    expect(offers[0].body).toMatchObject({
      type: "round_offer",
      roundId: id,
      floorMinor: 100,
      askingMinor: 100,
      links: { bid: `/api/agent/rounds/${id}/bid` },
    });
    const post = (key: string, body: unknown) =>
      w.t.fetch(`/api/agent/rounds/${id}/bid`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = await post(lk.key, { amountMinor: 200, reasoning: "Fits our launch" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "bid" });
    expect(await (await post(rivet.key, { amountMinor: null, reasoning: "Not today" })).json()).toEqual({ status: "passed" });
    expect((await w.round(id)).status).toBe("awarded");
  });

  test("the built-in company agent answers its round_offer with the rule-based bid", async () => {
    const w = await world({ companies: ["LaunchKit"] });
    const lk = w.companies[0];
    await lk.customer.mutation(api.companyAgents.setup, {
      campaignId: lk.campaignId,
      targetAudience: { startups: 1 },
      minRelevantViewers: 1,
      maxPerSpotMinor: 500,
      dailyBudgetMinor: 1000,
    });
    await w.t.run(async (ctx) => {
      const agent = (await ctx.db.query("companyAgents").first())!;
      await ctx.db.patch(agent._id, { balanceMinor: 1000 });
    });
    const id = (await w.start())!;
    await flush(w.t, 20);
    const [row] = await w.bids(id);
    const expected = ruleBasedStrategy({ floorMinor: 100, askingMinor: 100, match: row.match, crowd: null, maxPerSpotMinor: 500, budgetLeftMinor: 1000, balanceMinor: 1000 });
    expect(row).toMatchObject({ status: "won", amountMinor: expected.amountMinor, reasoning: expected.reasoning });
    expect((await w.round(id)).status).toBe("awarded");
  });
});
