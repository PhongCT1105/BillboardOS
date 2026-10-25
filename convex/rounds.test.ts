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
    // A paired device (auto-sell only sells real screens).
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
  const camera = (people: number) =>
    host.mutation(api.audience.addArrivals, { billboardId: led, arrivals: people, peakInView: people, confidence: 1, source: "camera" });
  return { t, host, workspaceId, led, companies, addCompany, start, round, bids, bid, camera };
}

/** Run everything scheduled "now", step by step, without jumping the clock. */
async function flush(t: TestClient, rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
  }
}

const roundsOn = (w: { t: TestClient; led: Id<"billboards"> }) =>
  w.t.run(async (ctx) =>
    ctx.db
      .query("rounds")
      .withIndex("by_billboard_and_createdAt", (q) => q.eq("billboardId", w.led))
      .take(20),
  );

/** A round priced at $2.00 (6 people in view, usually 3; floor $1.00), started by the camera. */
async function pricedAt200(w: Awaited<ReturnType<typeof world>>) {
  await w.camera(6);
  await flush(w.t);
  const [r] = await roundsOn(w);
  return r._id;
}

describe("rounds: start, offer, deal", () => {
  test("S1: every company gets the same offer; the first to accept takes the spot at that price", async () => {
    const w = await world();
    const [lk, rivet] = w.companies;
    const id = (await w.start())!;
    expect(await w.round(id)).toMatchObject({ status: "bidding", floorMinor: 100, askingMinor: 100, invitedCount: 2 });
    expect((await w.bids(id)).map((b) => [b.offerMinor, b.match, b.companyFactor])).toEqual([
      [100, 0.5, 1],
      [100, 0.5, 1],
    ]);
    expect(await w.bid(lk, id, 100)).toEqual({ status: "deal", priceMinor: 100 });
    const r = await w.round(id);
    expect(r).toMatchObject({ status: "awarded", priceMinor: 100, outcome: "LaunchKit took the spot at $1.00." });
    expect((await w.bids(id)).find((b) => b._id === r.winnerBidId)?.advertiserId).toBe(lk.advertiserId);
    expect((await w.bids(id)).find((b) => b.advertiserId === rivet.advertiserId)?.status).toBe("lost");
    // No company-vs-company bidding: a bigger offer after the deal is too late.
    expect(await errorCode(w.bid(rivet, id, 300))).toBe("ROUND_CLOSED");
  });

  test("S2: an offer under the price gets one counter halfway; the next offer at or above the floor is a deal", async () => {
    const w = await world();
    const [lk] = w.companies;
    const id = await pricedAt200(w);
    expect(await w.bid(lk, id, 120)).toEqual({ status: "countered", priceMinor: 160 });
    expect((await w.round(id)).status).toBe("bidding");
    await flush(w.t);
    const counter = webhooks.find((h) => h.event === "round_counter");
    expect(counter?.url).toBe("https://agent.test/launchkit");
    expect(counter?.body).toMatchObject({ type: "round_counter", priceMinor: 160, yourLastOfferMinor: 120, finalCounter: true });
    expect(await w.bid(lk, id, 130)).toEqual({ status: "deal", priceMinor: 130 });
    expect(await w.round(id)).toMatchObject({ status: "awarded", priceMinor: 130, outcome: "LaunchKit took the spot at $1.30 after a counter." });
  });

  test("S2b: each company negotiates alone; a counter to one doesn't change the other's price", async () => {
    const w = await world();
    const [lk, rivet] = w.companies;
    const id = await pricedAt200(w);
    await w.bid(lk, id, 120);
    expect((await w.bids(id)).find((b) => b.advertiserId === rivet.advertiserId)?.offerMinor).toBe(200);
    expect(await w.bid(rivet, id, 200)).toEqual({ status: "deal", priceMinor: 200 });
  });

  test("matching: a company whose buyers aren't in the crowd gets no offer, and the outcome says so", async () => {
    const w = await world({ companies: ["LaunchKit"] });
    await w.t.run(async (ctx) => ctx.db.patch(w.companies[0].campaignId, { targetAudience: { families: 1 } }));
    const id = (await w.start())!;
    expect(await w.round(id)).toMatchObject({ status: "unsold", invitedCount: 0 });
    expect((await w.round(id)).outcome).toMatch(/No company's buyers are in this crowd.*LaunchKit \(0% match\)/);
  });

  test("the research agent's price factor gives each company its own price (never under the floor)", async () => {
    const w = await world();
    const [lk, rivet] = w.companies;
    await w.t.run(async (ctx) => {
      for (const [c, f] of [[lk, 1.5], [rivet, 0.8]] as const) {
        await ctx.db.insert("companyResearch", {
          advertiserId: c.advertiserId,
          summary: "test",
          category: "test",
          audienceTags: { startups: 1 },
          priceFactor: f,
          reasoning: "test",
          sources: [],
          method: "rules",
          researchedAt: Date.now(),
        });
      }
    });
    const id = await pricedAt200(w);
    const bids = await w.bids(id);
    expect(bids.find((b) => b.advertiserId === lk.advertiserId)?.offerMinor).toBe(300);
    expect(bids.find((b) => b.advertiserId === rivet.advertiserId)?.offerMinor).toBe(160);
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

  test("S6: a screen without an audience profile sells the same way", async () => {
    const w = await world({ screenTags: null });
    const id = (await w.start())!;
    expect(await w.bid(w.companies[0], id, 100)).toEqual({ status: "deal", priceMinor: 100 });
  });

  test("S7: no deal by the deadline: unsold, with each company's last answer", async () => {
    const w = await world();
    const id = await pricedAt200(w);
    await w.bid(w.companies[1], id, 120);
    vi.advanceTimersByTime(10_100);
    await w.t.finishInProgressScheduledFunctions();
    const r = await w.round(id);
    expect(r.status).toBe("unsold");
    expect(r.outcome).toMatch(/LaunchKit: no answer/);
    expect(r.outcome).toMatch(/Rivet: offered \$1\.20, host asked \$1\.60/);
  });

  test("S10: no second round while one is open", async () => {
    const w = await world();
    expect(await w.start()).not.toBeNull();
    expect(await w.start()).toBeNull();
  });

  test("S11: an offer over the agent's own limit or under the floor is refused; a later valid one counts", async () => {
    const w = await world();
    const id = (await w.start())!;
    expect(await errorCode(w.bid(w.companies[0], id, 600))).toBe("OVER_LIMIT");
    expect(await errorCode(w.bid(w.companies[0], id, 50))).toBe("BELOW_FLOOR");
    expect(await w.bid(w.companies[0], id, 100)).toEqual({ status: "deal", priceMinor: 100 });
  });

  test("only invited companies can answer; a pass is final", async () => {
    const w = await world();
    const id = (await w.start())!;
    const late = await w.addCompany("Latecomer");
    expect(await errorCode(w.bid(late, id, 200))).toBe("NOT_INVITED");
    await w.bid(w.companies[0], id, null);
    expect(await errorCode(w.bid(w.companies[0], id, 100))).toBe("ALREADY_ANSWERED");
  });

  test("closing after a deal changes nothing", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.bid(w.companies[0], id, 100);
    const first = await w.round(id);
    await w.t.run(async (ctx) => closeRoundCore(ctx, id));
    expect(await w.round(id)).toEqual(first);
    expect(first.status).toBe("awarded");
  });
});

describe("rounds: agents talk over webhooks and the agent API", () => {
  test("S9: each invited agent gets a signed round_offer and answers over HTTP", async () => {
    const w = await world();
    const [lk] = w.companies;
    const id = (await w.start())!;
    await flush(w.t);
    const offers = webhooks.filter((h) => h.event === "round_offer");
    expect(offers.map((h) => h.url).sort()).toEqual(["https://agent.test/launchkit", "https://agent.test/rivet"]);
    expect(offers[0].body).toMatchObject({
      type: "round_offer",
      roundId: id,
      floorMinor: 100,
      priceMinor: 100,
      finalCounter: false,
      links: { bid: `/api/agent/rounds/${id}/bid` },
    });
    const res = await w.t.fetch(`/api/agent/rounds/${id}/bid`, {
      method: "POST",
      headers: { Authorization: `Bearer ${lk.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amountMinor: 100, reasoning: "Fits our launch" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "deal", priceMinor: 100 });
    expect((await w.round(id)).status).toBe("awarded");
  });

  async function builtIn(maxPerSpotMinor: number) {
    const w = await world({ companies: ["LaunchKit"] });
    const lk = w.companies[0];
    await lk.customer.mutation(api.companyAgents.setup, {
      campaignId: lk.campaignId,
      targetAudience: { startups: 1 },
      minRelevantViewers: 1,
      maxPerSpotMinor,
      dailyBudgetMinor: 1000,
    });
    await w.t.run(async (ctx) => {
      const agent = (await ctx.db.query("companyAgents").first())!;
      await ctx.db.patch(agent._id, { balanceMinor: 1000 });
    });
    return w;
  }

  test("the built-in company agent takes an offer within its limits", async () => {
    const w = await builtIn(500);
    const id = (await w.start())!;
    await flush(w.t, 20);
    const [row] = await w.bids(id);
    const expected = ruleBasedStrategy({ floorMinor: 100, priceMinor: 100, maxPerSpotMinor: 500, budgetLeftMinor: 1000, balanceMinor: 1000 });
    expect(row).toMatchObject({ amountMinor: expected.amountMinor, reasoning: expected.reasoning });
    // It got the spot and tried to pay; with no CDP keys here the payment is blocked, so the round ends unsold, saying why.
    const r = await w.round(id);
    expect(row.status).toBe("defaulted");
    expect(r.status).toBe("unsold");
    expect(r.outcome).toMatch(/^Payment failed: LaunchKit's payment failed: no CDP keys/);
  });

  test("the built-in company agent negotiates: counters at its limit, then closes after the host's counter", async () => {
    const w = await builtIn(150);
    const id = await pricedAt200(w);
    await flush(w.t, 40);
    // $2.00 asked; it offered its $1.50 limit, the host countered $1.75, it held at $1.50: a deal (then the test wallet can't pay).
    expect((await w.round(id)).priceMinor).toBe(150);
    expect(await w.bids(id)).toMatchObject([{ countered: true, offerMinor: 175, amountMinor: 150 }]);
  });
});

describe("rounds: deal, pay", () => {
  const TX = `0x${"ab".repeat(32)}`;

  async function dealt() {
    const w = await world();
    const [lk, rivet] = w.companies;
    const id = (await w.start())!;
    await w.bid(lk, id, 100);
    return { ...w, lk, rivet, id };
  }
  const holdOf = (w: { t: TestClient }, holdId: Id<"holds">) => w.t.run(async (ctx) => (await ctx.db.get(holdId))!);
  const pay = (w: { t: TestClient }, holdId: Id<"holds">, amountMinor: number, externalRef = TX) =>
    w.t.mutation(internal.payments.recordVerified, {
      holdId,
      provider: "x402",
      externalRef,
      amountMinor,
      asset: "USDC",
      network: "eip155:84532",
      idempotencyKey: `pay-${holdId}`,
    });

  test("the deal is a hold at the price; paying it with a tx hash marks the round paid and books the spot", async () => {
    const w = await dealt();
    const r = await w.round(w.id);
    expect(await holdOf(w, r.holdId!)).toMatchObject({ status: "active", amountMinor: 100 });
    await flush(w.t);
    expect(webhooks.filter((h) => h.event === "round_won").map((h) => h.url)).toEqual(["https://agent.test/launchkit"]);
    expect(webhooks.filter((h) => h.event === "round_lost").map((h) => h.url)).toEqual(["https://agent.test/rivet"]);
    expect(webhooks.find((h) => h.event === "round_won")?.body).toMatchObject({ holdId: r.holdId, amountMinor: 100 });

    expect(await pay(w, r.holdId!, 100)).toMatchObject({ outcome: "booked" });
    const paid = await w.round(w.id);
    expect(paid).toMatchObject({ status: "paid", paymentTx: TX });
    expect(paid.outcome).toMatch(/Paid \$1\.00 over x402/);
    const booking = await w.t.run(async (ctx) => ctx.db.query("bookings").withIndex("by_hold", (q) => q.eq("holdId", r.holdId!)).first());
    expect(booking).not.toBeNull();
  });

  test("S8: the payment fails: hold released, unsold with the reason (the next round offers the spot again)", async () => {
    const w = await dealt();
    const first = await w.round(w.id);
    await w.t.mutation(internal.rounds.paymentFailed, { holdId: first.holdId!, reason: "wallet empty" });
    expect(await holdOf(w, first.holdId!)).toMatchObject({ status: "released" });
    expect(await w.round(w.id)).toMatchObject({ status: "unsold", outcome: "Payment failed: LaunchKit's payment failed: wallet empty." });
  });

  test("the pay deadline passes with no payment in flight: same as a failed payment", async () => {
    const w = await dealt();
    vi.advanceTimersByTime(61_000);
    await w.t.finishInProgressScheduledFunctions();
    expect((await w.round(w.id)).outcome).toMatch(/^Payment failed: LaunchKit's payment failed: not paid within 60 s/);
  });

  test("the spot sold elsewhere before the deal: unsold, said so", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.t.run(async (ctx) => ctx.db.patch((await ctx.db.get(id))!.slotId, { state: "booked" }));
    expect(await w.bid(w.companies[0], id, 100)).toEqual({ status: "unavailable", priceMinor: null });
    expect(await w.round(id)).toMatchObject({ status: "unsold", outcome: "Spot was sold elsewhere." });
  });
});

describe("rounds: triggers", () => {
  test("S5: the camera starts a round priced on the crowd", async () => {
    const w = await world();
    const id = await pricedAt200(w);
    const r = await w.round(id);
    expect(r).toMatchObject({ trigger: "camera", crowd: 6, floorMinor: 100, askingMinor: 200 });
    expect(r.signals[0]).toMatchObject({ key: "crowd", factor: 2 });
    expect(await w.bid(w.companies[0], id, 200)).toEqual({ status: "deal", priceMinor: 200 });
  });

  test("S10: the camera waits 60 s after a round; Sell now doesn't", async () => {
    const w = await world();
    const id = (await w.start("camera"))!;
    await w.bid(w.companies[0], id, null);
    await w.bid(w.companies[1], id, null);
    expect((await w.round(id)).status).toBe("unsold");
    expect(await w.start("camera")).toBeNull();
    const now = await w.host.mutation(api.rounds.sellNow, { billboardId: w.led });
    expect(now.roundId).not.toBeNull();
    expect((await w.host.mutation(api.rounds.sellNow, { billboardId: w.led })).reason).toMatch(/already running/);
  });

  test("review: a burst of camera arrivals starts exactly one round", async () => {
    const w = await world();
    await w.camera(2);
    await w.camera(3);
    await w.camera(4);
    await flush(w.t);
    expect(await roundsOn(w)).toHaveLength(1);
  });

  test("S12: auto-sell is on by default: one round per idle online screen, at most one per 2 minutes; off, it starts nothing", async () => {
    const w = await world();
    await w.t.mutation(internal.rounds.autoSellTick, {});
    expect((await roundsOn(w)).map((r) => r.trigger)).toEqual(["timer"]);
    vi.advanceTimersByTime(60_000);
    await w.t.finishInProgressScheduledFunctions();
    await w.t.mutation(internal.rounds.autoSellTick, {});
    expect(await roundsOn(w)).toHaveLength(1);
    await w.host.mutation(api.rounds.setAutoSell, { enabled: false });
    vi.advanceTimersByTime(120_000);
    await w.t.finishInProgressScheduledFunctions();
    await w.t.mutation(internal.rounds.autoSellTick, {});
    expect(await roundsOn(w)).toHaveLength(1);
  });
});

describe("rounds: screens and pages", () => {
  test("the screen shows the offer, then plays the buyer's YouTube ad once paid with a tx hash", async () => {
    const w = await world();
    const [lk] = w.companies;
    await w.t.run(async (ctx) => {
      await ctx.db.patch(lk.campaignId, { creativeStorageId: undefined, creativeContentType: "youtube" });
      await ctx.db.insert("youtubeCreatives", {
        campaignId: lk.campaignId,
        advertiserId: lk.advertiserId,
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title: "LaunchKit in 30 seconds",
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        oembedStatus: "ok",
        attachedAt: Date.now(),
      });
    });
    const id = (await w.start())!;
    expect(await w.t.query(api.player.screenState, { billboardId: w.led })).toMatchObject({ mode: "auction", openingMinor: 100, minimumMinor: 100 });
    await w.bid(lk, id, 100);
    expect((await w.t.query(api.player.screenState, { billboardId: w.led })).mode).toBe("settling");
    const r = await w.round(id);
    await w.t.mutation(internal.payments.recordVerified, {
      holdId: r.holdId!,
      provider: "x402",
      externalRef: `0x${"cd".repeat(32)}`,
      amountMinor: r.priceMinor!,
      asset: "USDC",
      network: "eip155:84532",
      idempotencyKey: "pay-yt",
    });
    const playing = await w.t.query(api.player.screenState, { billboardId: w.led });
    expect(playing).toMatchObject({
      mode: "playing",
      nowPlaying: { company: "LaunchKit", wonAtMinor: 100, creative: { provider: "youtube", youtubeVideoId: "dQw4w9WgXcQ" } },
    });
    expect(playing.nowPlaying?.txShort).not.toBeNull();
  });

  test("the presenter sees every answer with its reasoning; the advertiser sees only its own", async () => {
    const w = await world();
    const [lk, rivet] = w.companies;
    const id = (await w.start())!;
    await w.bid(rivet, id, null, "Out of budget");
    await w.bid(lk, id, 100, "Founders in view");
    const live = await w.host.query(api.rounds.live, {});
    expect(live.autoSell).toBe(true);
    expect(live.screens[0].round?.bids.map((b) => [b.company, b.amountMinor, b.offerMinor, b.reasoning]).sort()).toEqual([
      ["LaunchKit", 100, 100, "Founders in view"],
      ["Rivet", null, 100, "Out of budget"],
    ]);
    const mine = await lk.customer.query(api.rounds.myRounds, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ screen: "LED", amountMinor: 100, bidStatus: "won", roundStatus: "awarded" });
  });
});

describe("rounds: final review fixes", () => {
  test("I-1: a round stuck past its close (its close never ran) is closed before a new round starts", async () => {
    const w = await world();
    const id = (await w.start())!;
    await w.t.run(async (ctx) => {
      for (const s of await ctx.db.system.query("_scheduled_functions").take(50)) {
        if (s.name.includes("closeRound") && s.state.kind === "pending") await ctx.scheduler.cancel(s._id);
      }
    });
    vi.advanceTimersByTime(30_000);
    const next = await w.host.mutation(api.rounds.sellNow, { billboardId: w.led });
    expect((await w.round(id)).status).toBe("unsold");
    expect(next.roundId).not.toBeNull();
  });

  test("I-2 (S10): no round while the spot on air is sold, even if the next slot is free", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const now = Date.now();
      const start = now - (now % (15 * 60_000));
      await ctx.db.insert("slots", { billboardId: w.led, workspaceId: w.workspaceId, startAt: start, endAt: start + 15 * 60_000, state: "booked" });
    });
    expect(await w.start("camera")).toBeNull();
    expect((await w.host.mutation(api.rounds.sellNow, { billboardId: w.led })).reason).toMatch(/already sold/);
  });

  test("I-3: the public screen shows how many companies are negotiating, never who offered what", async () => {
    const w = await world({ companies: ["LaunchKit", "Rivet", "Quiet"] });
    const id = await pricedAt200(w);
    await w.bid(w.companies[0], id, 120);
    await w.bid(w.companies[1], id, 150);
    expect(await w.t.query(api.player.screenState, { billboardId: w.led })).toMatchObject({ mode: "auction", sealedBids: 2 });
  });
});
