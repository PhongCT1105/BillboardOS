/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, signedInCustomer, signedInOperator, type TestClient } from "./test.setup";
import { closeRoundCore, startRoundCore } from "./rounds";
import { ruleBasedStrategy } from "./lib/rounds";

// Sunday 2026-10-25, 09:07 PDT.
const START = Date.UTC(2026, 9, 25, 16, 7);
const SITE = "https://site.test";
const SECRET = "test-internal-secret-0123456789";
const STANDING = { maxPricePerSpotMinor: 500, minRelevantViewers: 1, dailyBudgetMinor: 1000 };
const WINDOW = 30_000;

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

/** Run everything scheduled "now", step by step, without jumping the clock. */
async function flush(t: TestClient, rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
  }
}

/**
 * A host with paired screen "LED" (floor $1.00, online) and the named
 * companies, each with an approved ad and an agent key (hold, pay, bid) with a
 * webhook and limits. `factors` sets each company's research price factor
 * (0.8 = brand 0, 1.5 = brand 1).
 */
async function world(opts: { companies?: string[]; factors?: number[]; screenTags?: Record<string, number> | null } = {}) {
  const t = convexTest(schema, modules);
  current = t;
  const host = await signedInOperator(t, "host@venue.test");
  const workspaceId = await t.run(async (ctx) => (await ctx.db.query("workspaces").withIndex("by_name", (q) => q.eq("name", "Moscone Media")).first())!._id);
  const { led, deviceId } = await t.run(async (ctx) => {
    const id = await ctx.db.insert("billboards", {
      workspaceId,
      name: "LED",
      city: "San Francisco",
      locationLabel: "LED at the venue",
      utcOffsetMinutes: -420,
      reserveFloorMinor: 100,
      baseRateMinor: 100,
      deviceStatus: "online",
      ...(opts.screenTags === null ? {} : { audienceTags: opts.screenTags ?? { startups: 0.5, software: 0.5 } }),
    });
    const deviceId = await ctx.db.insert("screenDevices", {
      deviceKeyHash: "test",
      pairingCode: "TEST01",
      codeExpiresAt: 0,
      billboardId: id,
      utcOffsetMinutes: -420,
      lastSeenAt: Date.now(),
      createdAt: Date.now(),
    });
    await ctx.db.patch(id, { deviceId });
    return { led: id, deviceId };
  });

  async function addCompany(name: string, factor?: number) {
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
    const issued = await t.mutation(internal.agentKeys.issueForCompany, { company: name, name: `${name} agent`, budgetCapMinor: 10_000, scopes: ["hold", "pay", "bid"] });
    await t.run(async (ctx) => {
      await ctx.db.patch(issued.agentKeyId, { webhookUrl: `https://agent.test/${slug}`, standing: STANDING });
      if (factor !== undefined) {
        const row = await ctx.db.query("companyResearch").withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId)).unique();
        const fields = { advertiserId, summary: name, category: "test", audienceTags: { startups: 1 }, priceFactor: factor, reasoning: "test", sources: [], method: "rules" as const, researchedAt: Date.now() };
        if (row) await ctx.db.replace(row._id, fields);
        else await ctx.db.insert("companyResearch", fields);
      }
    });
    const customer = await signedInCustomer(t, advertiserId, `buyer@${slug}.test`);
    return { name, advertiserId, campaignId, agentKeyId: issued.agentKeyId, key: issued.key, customer };
  }

  const names = opts.companies ?? ["LaunchKit", "Rivet"];
  const companies = [];
  for (let i = 0; i < names.length; i++) companies.push(await addCompany(names[i], opts.factors?.[i] ?? 1.5 - i * 0.7));

  const start = (trigger: "camera" | "sell_now" | "timer" = "sell_now") => t.run(async (ctx) => startRoundCore(ctx, led, trigger));
  const round = (id: Id<"rounds">) => t.run(async (ctx) => (await ctx.db.get(id))!);
  const bids = (id: Id<"rounds">) => t.run(async (ctx) => ctx.db.query("roundBids").withIndex("by_round", (q) => q.eq("roundId", id)).take(20));
  const bidOf = async (id: Id<"rounds">, c: { advertiserId: Id<"advertisers"> }) => (await bids(id)).find((b) => b.advertiserId === c.advertiserId)!;
  const bid = (c: { key: string }, roundId: Id<"rounds">, amountMinor: number | null, reasoning = "test") =>
    t.mutation(internal.rounds.submitBid, { token: c.key, roundId, amountMinor, reasoning });
  /** Let the window's 30 seconds run out: the close runs (and starts the next round). */
  const close = async () => {
    vi.advanceTimersByTime(WINDOW + 100);
    await t.finishInProgressScheduledFunctions();
  };
  const roundsOn = () => t.run(async (ctx) => ctx.db.query("rounds").withIndex("by_billboard_and_createdAt", (q) => q.eq("billboardId", led)).take(20));
  return { t, host, workspaceId, led, deviceId, companies, addCompany, start, round, bids, bidOf, bid, close, roundsOn };
}

describe("rounds: each company gets its own price for the next 30-second window", () => {
  test("price = a x predicted + b x people + c x brand: the bigger brand is offered more; offers are logged", async () => {
    const w = await world(); // LaunchKit brand 1 (x1.5), Rivet brand 0 (x0.8)
    const [lk, rivet] = w.companies;
    const id = (await w.start())!;
    const r = await w.round(id);
    expect(r).toMatchObject({ status: "bidding", closesAt: r.createdAt + WINDOW, spotStartAt: r.createdAt + WINDOW, spotEndAt: r.createdAt + 2 * WINDOW, floorMinor: 100 });
    expect(r.pricing).toMatchObject({ predictedMinor: 100, modelId: null, people: null, a: 1, b: 0.5, c: 3, capMultiplier: 2 });
    expect((await w.bidOf(id, lk)).offerMinor).toBe(103); // 100 + 0 + 3 x 1
    expect((await w.bidOf(id, rivet)).offerMinor).toBe(100); // 100 + 0 + 3 x 0
    const steps = await w.t.run(async (ctx) => ctx.db.query("negotiationSteps").withIndex("by_round", (q) => q.eq("roundId", id)).take(10));
    expect(steps.map((s) => [s.actor, s.kind, s.amountMinor]).sort()).toEqual([
      ["host", "offer", 100],
      ["host", "offer", 103],
    ]);
  });

  test("people in view from the screen's camera raise every price (b x people)", async () => {
    const w = await world();
    await w.t.run(async (ctx) => ctx.db.patch(w.deviceId, { peopleNow: 10, peopleAt: Date.now() }));
    const id = (await w.start())!;
    expect((await w.round(id)).pricing?.people).toBe(10);
    expect((await w.bidOf(id, w.companies[0])).offerMinor).toBe(108); // 100 + 0.5 x 10 + 3
  });

  test("with a trained model, the predicted price comes from the model", async () => {
    const w = await world();
    await w.t.mutation(internal.pricing.simulate, { days: 2 });
    expect(await w.t.mutation(internal.pricing.train, {})).toMatchObject({ liveSamples: 0 });
    const id = (await w.start())!;
    const r = await w.round(id);
    expect(r.pricing?.modelId).not.toBeNull();
    expect(r.pricing?.predictedMinor).toBeGreaterThan(0);
  });

  test("matching: a company whose buyers aren't in the crowd gets no offer, and the window says so", async () => {
    const w = await world({ companies: ["LaunchKit"] });
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.companies[0].campaignId, { targetAudience: { families: 1 } });
      const r = (await ctx.db.query("companyResearch").first())!;
      await ctx.db.patch(r._id, { audienceTags: { families: 1 } });
    });
    const id = (await w.start())!;
    expect(await w.round(id)).toMatchObject({ status: "bidding", invitedCount: 0 });
    expect((await w.round(id)).outcome).toMatch(/LaunchKit \(0% match\)/);
  });
});

describe("rounds: two turns each, the highest agreed price wins at the end", () => {
  test("agreeing first doesn't win: when the 30 s are up the highest agreed price does", async () => {
    const w = await world();
    const [lk, rivet] = w.companies;
    const id = (await w.start())!;
    expect(await w.bid(rivet, id, 100)).toEqual({ status: "agreed", priceMinor: 100 });
    expect(await w.bid(lk, id, 103)).toEqual({ status: "agreed", priceMinor: 103 });
    expect((await w.round(id)).status).toBe("bidding");
    await w.close();
    const r = await w.round(id);
    expect(r).toMatchObject({ status: "awarded", priceMinor: 103, outcome: "LaunchKit wins at $1.03; Rivet $1.00." });
    expect((await w.bidOf(id, rivet)).status).toBe("lost");
    // The window is saved for the price model, and the next window's round is already running.
    const saved = await w.t.run(async (ctx) => ctx.db.query("priceWindows").take(5));
    expect(saved).toMatchObject([{ at: r.spotStartAt, winnerMinor: 103, source: "live" }]);
    const all = await w.roundsOn();
    expect(all.map((x) => x.status).sort()).toEqual(["awarded", "bidding"]);
    expect(all.find((x) => x.status === "bidding")!.spotStartAt).toBeGreaterThanOrEqual(r.spotEndAt);
  });

  test("an offer under the price gets one counter halfway; the second answer is final", async () => {
    const w = await world();
    const [lk] = w.companies; // offered 103
    const id = (await w.start())!;
    expect(await w.bid(lk, id, 101)).toEqual({ status: "countered", priceMinor: 102 });
    await flush(w.t);
    expect(webhooks.find((h) => h.event === "round_counter")?.body).toMatchObject({ type: "round_counter", priceMinor: 102, yourLastOfferMinor: 101, finalCounter: true });
    expect(await w.bid(lk, id, 101)).toEqual({ status: "agreed", priceMinor: 101 });
    expect(await errorCode(w.bid(lk, id, 102))).toBe("ALREADY_ANSWERED");
    const steps = await w.t.run(async (ctx) => ctx.db.query("negotiationSteps").withIndex("by_round", (q) => q.eq("roundId", id)).take(10));
    expect(steps.filter((s) => s.advertiserId === lk.advertiserId).map((s) => [s.actor, s.kind, s.amountMinor])).toEqual([
      ["host", "offer", 103],
      ["company", "counter", 101],
      ["host", "counter", 102],
      ["company", "counter", 101],
      ["host", "accept", 101],
    ]);
  });

  test("nobody agrees: the house ad plays that window, and the loop goes on", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.bid(w.companies[0], id, null, "Too pricey for us");
    await w.close();
    const r = await w.round(id);
    expect(r.status).toBe("unsold");
    expect(r.outcome).toMatch(/^House ad plays this window\..*Too pricey for us.*Rivet: no answer/);
    expect(await w.t.run(async (ctx) => ctx.db.query("priceWindows").take(5))).toMatchObject([{ winnerMinor: null }]);
    expect((await w.roundsOn()).filter((x) => x.status === "bidding")).toHaveLength(1);
  });

  test("the loop stops when auto-sell is off or the screen goes offline", async () => {
    const w = await world();
    await w.host.mutation(api.rounds.setAutoSell, { enabled: false });
    await w.start();
    await w.close();
    expect((await w.roundsOn()).filter((x) => x.status === "bidding")).toHaveLength(0);
    await w.host.mutation(api.rounds.setAutoSell, { enabled: true });
    await w.t.run(async (ctx) => ctx.db.patch(w.led, { deviceStatus: "offline" }));
    await w.host.mutation(api.rounds.sellNow, { billboardId: w.led });
    await w.close();
    expect((await w.roundsOn()).filter((x) => x.status === "bidding")).toHaveLength(0);
  });

  test("limits: over the agent's own limit or under the floor is refused; only invited keys answer; closed is closed", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.t.run(async (ctx) => ctx.db.patch(w.companies[0].agentKeyId, { standing: { ...STANDING, maxPricePerSpotMinor: 101 } }));
    expect(await errorCode(w.bid(w.companies[0], id, 103))).toBe("OVER_LIMIT");
    expect(await errorCode(w.bid(w.companies[0], id, 50))).toBe("BELOW_FLOOR");
    const late = await w.addCompany("Latecomer");
    expect(await errorCode(w.bid(late, id, 200))).toBe("NOT_INVITED");
    await w.close();
    expect(await errorCode(w.bid(w.companies[1], id, 100))).toBe("ROUND_CLOSED");
  });

  test("Sell now while a sale runs says so; a round stuck past its close is closed first", async () => {
    const w = await world();
    const id = (await w.start())!;
    expect((await w.host.mutation(api.rounds.sellNow, { billboardId: w.led })).reason).toMatch(/already running/);
    await w.t.run(async (ctx) => {
      for (const s of await ctx.db.system.query("_scheduled_functions").take(50)) {
        if (s.name.includes("closeRound") && s.state.kind === "pending") await ctx.scheduler.cancel(s._id);
      }
    });
    vi.advanceTimersByTime(WINDOW + 15_000);
    expect((await w.host.mutation(api.rounds.sellNow, { billboardId: w.led })).roundId).not.toBeNull();
    expect((await w.round(id)).status).toBe("unsold");
    await w.t.run(async (ctx) => closeRoundCore(ctx, id)); // idempotent
  });
});

describe("rounds: agents over webhooks and the agent API", () => {
  test("each invited agent gets a signed round_offer with its price, why, and the window; it answers over HTTP", async () => {
    const w = await world();
    const [lk] = w.companies;
    const id = (await w.start())!;
    await flush(w.t);
    const offer = webhooks.find((h) => h.event === "round_offer" && h.url.endsWith("/launchkit"))!;
    expect(offer.body).toMatchObject({
      type: "round_offer",
      roundId: id,
      floorMinor: 100,
      priceMinor: 103,
      finalCounter: false,
      priceTerms: { modelMinor: 100, peopleMinor: 0, brandMinor: 3 },
      window: { startsAt: (await w.round(id)).spotStartAt, endsAt: (await w.round(id)).spotEndAt },
      links: { bid: `/api/agent/rounds/${id}/bid` },
    });
    const res = await w.t.fetch(`/api/agent/rounds/${id}/bid`, {
      method: "POST",
      headers: { Authorization: `Bearer ${lk.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amountMinor: 103, reasoning: "Fits our launch" }),
    });
    expect(await res.json()).toEqual({ status: "agreed", priceMinor: 103 });
  });

  test("the built-in company agent (rules without a Claude key) agrees within its limits, wins, and tries to pay", async () => {
    const w = await world({ companies: ["LaunchKit"] });
    const lk = w.companies[0];
    await lk.customer.mutation(api.companyAgents.setup, { campaignId: lk.campaignId, targetAudience: { startups: 1 }, minRelevantViewers: 1, maxPerSpotMinor: 500, dailyBudgetMinor: 1000 });
    await w.t.run(async (ctx) => {
      const agent = (await ctx.db.query("companyAgents").first())!;
      await ctx.db.patch(agent._id, { balanceMinor: 1000 });
    });
    const id = (await w.start())!;
    await flush(w.t, 20);
    const row = (await w.bids(id))[0];
    const expected = ruleBasedStrategy({ floorMinor: 100, priceMinor: 103, maxPerSpotMinor: 500, budgetLeftMinor: 1000, balanceMinor: 1000 });
    expect(row).toMatchObject({ status: "bid", amountMinor: 103, reasoning: expected.reasoning });
    await w.close();
    await flush(w.t, 20);
    // It won; with no CDP keys here the payment is blocked, so the house ad plays, saying why.
    expect((await w.round(id)).outcome).toMatch(/^Payment failed: LaunchKit's payment failed: no CDP keys/);
  });
});

describe("rounds: pay, then play", () => {
  const TX = `0x${"ab".repeat(32)}`;
  const pay = (t: TestClient, holdId: Id<"holds">, amountMinor: number) =>
    t.mutation(internal.payments.recordVerified, { holdId, provider: "x402", externalRef: TX, amountMinor, asset: "USDC", network: "eip155:84532", idempotencyKey: `pay-${holdId}` });

  test("the winner pays its hold with a tx hash; the screen plays its window, with the proof", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.bid(w.companies[0], id, 103);
    await w.close();
    const r = await w.round(id);
    await flush(w.t);
    expect(webhooks.find((h) => h.event === "round_won")?.body).toMatchObject({ holdId: r.holdId, amountMinor: 103 });
    expect(await pay(w.t, r.holdId!, 103)).toMatchObject({ outcome: "booked" });
    expect(await w.round(id)).toMatchObject({ status: "paid", paymentTx: TX });
    const screen = await w.t.query(api.player.screenState, { billboardId: w.led });
    expect(screen.windows.find((x) => x.roundId === id)).toMatchObject({ status: "paid", company: "LaunchKit", priceMinor: 103, spotStartAt: r.spotStartAt, txShort: "0xabab…abab" });
    expect(screen.bidding).toMatchObject({ offered: 2, agreed: 0 });
  });

  test("the payment fails: the hold is released and the house ad plays that window", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.bid(w.companies[0], id, 103);
    await w.close();
    const r = await w.round(id);
    await w.t.mutation(internal.rounds.paymentFailed, { holdId: r.holdId!, reason: "wallet empty" });
    expect((await w.round(id)).outcome).toBe("Payment failed: LaunchKit's payment failed: wallet empty. House ad plays this window.");
  });

  test("the presenter sees every company's price, answer and why; the advertiser sees only its own", async () => {
    const w = await world();
    const [lk, rivet] = w.companies;
    const id = (await w.start())!;
    await w.bid(rivet, id, null, "Out of budget");
    await w.bid(lk, id, 103, "Founders in view");
    const live = await w.host.query(api.rounds.live, {});
    expect(live.autoSell).toBe(true);
    expect(live.screens[0].round?.bids.map((b) => [b.company, b.offerMinor, b.amountMinor, b.status, b.reasoning]).sort()).toEqual([
      ["LaunchKit", 103, 103, "bid", "Founders in view"],
      ["Rivet", 100, null, "passed", "Out of budget"],
    ]);
    const mine = await lk.customer.query(api.rounds.myRounds, {});
    expect(mine).toMatchObject([{ screen: "LED", offerMinor: 103, amountMinor: 103, bidStatus: "bid" }]);
  });
});
