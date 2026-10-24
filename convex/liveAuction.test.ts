import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as momentsModule from "./moments";
import * as paymentsModule from "./payments";
import { modules, signedInCustomer, signedInOperator, type TestClient } from "./test.setup";
import { ensureUpcomingSlots } from "./lib/inventory";
import { BIDDING_MS, EXTENSION_MS, MAX_EXTENSIONS, NEXT_SPOT_LEAD_MS, REOFFER_DELAY_MS, minNextLiveBid } from "./lib/liveAuction";
import { onMomentPaid, releaseWorkspace } from "./lib/momentHooks";
import { rankReplies, standingCovers } from "./lib/moment";
import { decryptSecret, encryptSecret } from "./lib/demoCrypto";

/**
 * A stand-in for the CDP SDK, used only by tests that set the CDP env (all
 * others leave it unset, so the agents never load the SDK). It records faucet
 * claims instead of calling Coinbase.
 */
const cdpFake = vi.hoisted(() => ({ faucetClaims: [] as string[], usdcAtomic: 0n }));
vi.mock("@coinbase/cdp-sdk", () => ({
  CdpClient: class {
    evm = {
      getOrCreateAccount: async ({ name }: { name: string }) => ({
        address: `0x${Array.from(name).map((c) => c.charCodeAt(0).toString(16)).join("").slice(0, 40).padEnd(40, "0")}`,
      }),
      listTokenBalances: async () => ({ balances: [{ token: { symbol: "USDC" }, amount: { amount: cdpFake.usdcAtomic, decimals: 6 } }] }),
      requestFaucet: async ({ address, token }: { address: string; token: string }) => {
        cdpFake.faucetClaims.push(`${token}:${address}`);
        return { transactionHash: `0x${"ab".repeat(32)}` };
      },
    };
  },
}));

// Sunday 2026-10-25, 09:07 PDT.
const START = Date.UTC(2026, 9, 25, 16, 7);
const SITE = "https://site.test";
const SECRET = "test-internal-secret-0123456789";
const MINUTE = 60_000;
const BUCKET_MS = 15 * MINUTE;

let current: TestClient | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  process.env.INTERNAL_API_SECRET = SECRET;
  process.env.CONVEX_SITE_URL = SITE;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(SITE) && current) return await current.fetch(url.slice(SITE.length), init);
      if (url.startsWith("https://agent.test/")) return new Response("ok", { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.CONVEX_SITE_URL;
  current = null;
});

const STANDING = { maxPricePerSpotMinor: 150, minRelevantViewers: 3, dailyBudgetMinor: 500 };

/**
 * A host with screen "LED" and two customer companies, LaunchKit and Rivet,
 * each with an active campaign, an uploaded creative the host approved, and an
 * agent key (hold, pay, bid) with a webhook and standing instructions.
 */
async function liveWorld() {
  const t = convexTest(schema, modules);
  current = t;
  const host = await signedInOperator(t, "host@venue.test");
  const workspaceId = await t.run(async (ctx) => {
    const ws = await ctx.db
      .query("workspaces")
      .withIndex("by_name", (q) => q.eq("name", "Moscone Media"))
      .first();
    return ws!._id;
  });

  async function addScreen(name: string): Promise<Id<"billboards">> {
    return await t.run(async (ctx) => {
      const id = await ctx.db.insert("billboards", {
        workspaceId,
        name,
        city: "San Francisco",
        locationLabel: `${name} at the venue`,
        utcOffsetMinutes: -420,
        reserveFloorMinor: 25,
        baseRateMinor: 300,
        deviceStatus: "online",
        audienceTags: { startups: 0.5, software: 0.3, tourists: 0.2 },
      });
      await ensureUpcomingSlots(ctx, id, Date.now());
      return id;
    });
  }

  async function addCampaign(advertiserId: Id<"advertisers">, brief: string, targetAudience: Record<string, number>) {
    const campaignId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["<svg/>"], { type: "image/svg+xml" }));
      return await ctx.db.insert("campaigns", {
        advertiserId,
        brief,
        targetCity: "San Francisco",
        budgetMinor: 100_000,
        currency: "USD",
        status: "active",
        creativeStatus: "pending_review",
        creativeStorageId: storageId,
        creativeContentType: "image/svg+xml",
        creativeSubmittedAt: Date.now(),
        targetAudience,
      });
    });
    await host.mutation(api.creatives.setReady, { campaignId, ready: true });
    return campaignId;
  }

  async function addCompany(name: string) {
    const slug = name.toLowerCase();
    const advertiserId = await t.run(async (ctx) => ctx.db.insert("advertisers", { displayName: name, paymentTerms: "prepay" }));
    const campaignId = await addCampaign(advertiserId, `${name} launch`, { startups: 1 });
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

  const led = await addScreen("LED");
  const launchKit = await addCompany("LaunchKit");
  const rivet = await addCompany("Rivet");

  /** The camera reports `people` in view on a screen (as the host's sensor laptop). */
  async function camera(billboardId: Id<"billboards">, people: number) {
    return await host.mutation(api.audience.addArrivals, { billboardId, arrivals: people, peakInView: people, confidence: 1, source: "camera" });
  }

  /** Run everything scheduled "now", step by step, without jumping the clock. */
  async function flush(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
      vi.advanceTimersByTime(1);
      await t.finishInProgressScheduledFunctions();
    }
  }

  async function momentsOf(billboardId: Id<"billboards">) {
    return await t.run(async (ctx) =>
      ctx.db
        .query("moments")
        .withIndex("by_billboard", (q) => q.eq("billboardId", billboardId))
        .take(50),
    );
  }

  async function offersOf(momentId: Id<"moments">) {
    return await t.run(async (ctx) =>
      ctx.db
        .query("flashOffers")
        .withIndex("by_moment", (q) => q.eq("momentId", momentId))
        .take(20),
    );
  }

  async function pendingDetects() {
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    return scheduled.filter((s) => s.name.includes("detectFor") && s.state.kind === "pending");
  }

  /** Nobody can buy: both companies' keys are revoked. */
  async function revokeAll() {
    await launchKit.customer.mutation(api.agentKeys.revoke, { agentKeyId: launchKit.agentKeyId });
    await rivet.customer.mutation(api.agentKeys.revoke, { agentKeyId: rivet.agentKeyId });
  }

  type Company = typeof launchKit;

  /** The company's agent calls the agent API with its bearer key. */
  async function agent(company: Company, path: string, body: Record<string, unknown>) {
    const res = await t.fetch(`/api/agent/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${company.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }
  const reply = (company: Company, offerId: Id<"flashOffers">, decision: "accept" | "counter" | "pass", amountMinor?: number) =>
    agent(company, `offers/${offerId}/reply`, { decision, amountMinor });
  const bid = (company: Company, offerId: Id<"flashOffers">, amountMinor: number) => agent(company, `offers/${offerId}/bid`, { amountMinor });

  async function momentDoc(momentId: Id<"moments">) {
    return (await t.run(async (ctx) => ctx.db.get(momentId)))!;
  }

  async function bidsOf(momentId: Id<"moments">) {
    return await t.run(async (ctx) =>
      ctx.db
        .query("momentBids")
        .withIndex("by_moment", (q) => q.eq("momentId", momentId))
        .take(50),
    );
  }

  /** The camera sees `people` on a screen; returns its new moment and each company's offer. */
  async function announce(billboardId: Id<"billboards"> = led, people = 10) {
    await camera(billboardId, people);
    await flush();
    const all = await momentsOf(billboardId);
    const m = all[all.length - 1];
    const offers = await offersOf(m._id);
    const offerOf = (c: Company) => offers.find((o) => o.advertiserId === c.advertiserId)!._id;
    return { m, lk: offerOf(launchKit), rv: offerOf(rivet) };
  }

  /** Announce on the LED, both companies join, and the join window passes: bidding is open. */
  async function auction() {
    const a = await announce();
    expect((await reply(launchKit, a.lk, "accept")).status).toBe(200);
    expect((await reply(rivet, a.rv, "accept")).status).toBe(200);
    vi.advanceTimersByTime(2_000);
    await t.finishInProgressScheduledFunctions();
    await flush();
    return { ...a, m: await momentDoc(a.m._id) };
  }

  /** Move the clock and run what came due. */
  async function advance(ms: number) {
    vi.advanceTimersByTime(ms);
    await t.finishInProgressScheduledFunctions();
    await flush();
  }

  return {
    t,
    host,
    workspaceId,
    led,
    launchKit,
    rivet,
    addScreen,
    addCampaign,
    camera,
    flush,
    momentsOf,
    offersOf,
    pendingDetects,
    revokeAll,
    agent,
    reply,
    bid,
    momentDoc,
    bidsOf,
    announce,
    auction,
    advance,
  };
}

describe("live auction settings", () => {
  test("settings defaults: 1 person in view, 2 s join window, no cooldown or rehearsal", async () => {
    const t = convexTest(schema, modules);
    current = t;
    const host = await signedInOperator(t, "host@moscone.test");
    expect(await host.query(api.moments.settings, {})).toEqual({ enabled: true, minPeopleInView: 1, joinWindowSeconds: 2, minMatch: 0.3 });
  });
});

describe("pure moment logic", () => {
  test("standing instructions and winner ranking", () => {
    const s = { maxPricePerSpotMinor: 3000, minRelevantViewers: 10, dailyBudgetMinor: 5000 };
    expect(standingCovers(s, { floorMinor: 3500, relevantViewers: 20, spentTodayMinor: 0 })).toMatch(/below the seller's floor/);
    expect(standingCovers(s, { floorMinor: 2500, relevantViewers: 5, spentTodayMinor: 0 })).toMatch(/fewer than 10/);
    expect(standingCovers(s, { floorMinor: 2500, relevantViewers: 20, spentTodayMinor: 3000 })).toMatch(/daily budget/);
    expect(standingCovers(s, { floorMinor: 2500, relevantViewers: 20, spentTodayMinor: 0 })).toBeNull();
    const ranked = rankReplies(
      [
        { offerId: "a", status: "countered", amountMinor: 2900, repliedAt: 3 },
        { offerId: "b", status: "accepted", amountMinor: 3000, repliedAt: 5 },
        { offerId: "c", status: "accepted", amountMinor: 3000, repliedAt: 4 },
        { offerId: "d", status: "countered", amountMinor: 2000, repliedAt: 1 },
        { offerId: "e", status: "passed", amountMinor: null, repliedAt: 1 },
      ],
      2700,
    );
    expect(ranked.map((r) => r.offerId)).toEqual(["c", "b", "a"]);
  });

  test("agent key encryption round-trip, and a different secret can't read it", async () => {
    const sealed = await encryptSecret(SECRET, "bos_agent_00000000_secret");
    expect(sealed.ciphertext).not.toContain("bos_agent");
    expect(await decryptSecret(SECRET, sealed.ciphertext, sealed.iv)).toBe("bos_agent_00000000_secret");
    await expect(decryptSecret("another-secret-0123456789", sealed.ciphertext, sealed.iv)).rejects.toThrow();
  });
});

describe("announce", () => {
  test("announce: camera people in view, live price and why, one offer per company", async () => {
    const w = await liveWorld();
    await w.camera(w.led, 10);
    await w.flush();
    const [m] = await w.momentsOf(w.led);
    expect(m).toMatchObject({ status: "offering", trigger: "arrivals", peopleInView: 10, crowd: 10, crowdSource: "camera", floorMinor: 25, reofferRound: 0 });
    expect(m.valueMinor).toBeGreaterThan(0);
    expect(m.priceMinor).toBeGreaterThanOrEqual(25);
    expect(m.priceMinor).toBeLessThanOrEqual(m.valueMinor!);
    expect(m.priceWhy).toContain("10 people ×");
    expect(m.reasoning).toBe(m.priceWhy);
    expect(m.offerClosesAt).toBe(m.startedAt + 2_000);
    const offers = await w.offersOf(m._id);
    expect(offers).toHaveLength(2);
    expect(offers.every((o) => o.priceMinor === m.priceMinor && o.simulatedAgent === undefined)).toBe(true);
    expect(new Set(offers.map((o) => o.advertiserId))).toEqual(new Set([w.launchKit.advertiserId, w.rivet.advertiserId]));
    // The join window closes on time (Task 6 decides what happens next).
    const scheduled = await w.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s) => s.name.includes("liveAuction") && s.name.includes("closeJoin") && s.state.kind === "pending")).toBe(true);
    expect(scheduled.some((s) => s.name.includes("moments") && s.name.includes(":close") && !s.name.includes("closeJoin"))).toBe(false);

    // Review Focus 4: a company with two approved campaigns still gets exactly one offer.
    await w.addCampaign(w.launchKit.advertiserId, "LaunchKit for engineers", { software: 1, startups: 0.5 });
    await w.t.run(async (ctx) => {
      await ctx.db.patch(m._id, { status: "failed" });
      await ctx.db.patch(m.slotId, { state: "booked" });
    });
    await w.camera(w.led, 10);
    await w.flush();
    const all = await w.momentsOf(w.led);
    expect(all).toHaveLength(2);
    expect(all[1].slotId).not.toBe(m.slotId);
    const again = await w.offersOf(all[1]._id);
    expect(again).toHaveLength(2);
    expect(new Set(again.map((o) => o.advertiserId)).size).toBe(2);
  });

  test("reach target: a company needing more matching people gets no offer", async () => {
    const w = await liveWorld();
    await w.t.run(async (ctx) => ctx.db.patch(w.rivet.agentKeyId, { standing: { ...STANDING, minRelevantViewers: 50 } }));
    await w.camera(w.led, 10);
    await w.flush();
    const [m] = await w.momentsOf(w.led);
    expect(m.status).toBe("offering");
    const offers = await w.offersOf(m._id);
    expect(offers).toHaveLength(1);
    expect(offers[0].advertiserId).toBe(w.launchKit.advertiserId);
    expect(m.steps.find((s) => s.key === "targeted")?.detail).toMatch(/skipped Rivet: fewer than 50 relevant viewers/);
  });

  test("simulated and stale readings never announce", async () => {
    const w = await liveWorld();
    await w.t.run(async (ctx) =>
      ctx.db.insert("audienceAggregates", {
        workspaceId: w.workspaceId,
        billboardId: w.led,
        bucketStart: START - (START % BUCKET_MS),
        countEstimate: 30,
        peakInView: 30,
        source: "simulated",
        confidence: 1,
      }),
    );
    const simulated = await w.t.mutation(internal.moments.detectFor, { billboardId: w.led, trigger: "arrivals" });
    expect(simulated).toEqual({ momentId: null, reason: "no camera reading in the last 15 minutes" });
    expect(await w.momentsOf(w.led)).toHaveLength(0);

    // Review Focus 2: a camera reading older than 15 minutes never announces.
    await w.camera(w.led, 10);
    await w.flush();
    const [first] = await w.momentsOf(w.led);
    expect(first.status).toBe("offering");
    await w.t.run(async (ctx) => ctx.db.patch(first._id, { status: "failed" }));
    vi.setSystemTime(Date.now() + 16 * MINUTE);
    const stale = await w.t.mutation(internal.moments.detectFor, { billboardId: w.led, trigger: "arrivals" });
    expect(stale.momentId).toBeNull();
    expect(stale.reason).toMatch(/no camera reading/);
    expect(await w.momentsOf(w.led)).toHaveLength(1);
  });

  test("one auction at a time per host: the second screen queues", async () => {
    const w = await liveWorld();
    const phone = await w.addScreen("Phone");
    await w.camera(w.led, 10);
    await w.flush();
    expect((await w.momentsOf(w.led))[0].status).toBe("offering");
    const queuedAt = Date.now();
    await w.camera(phone, 10);
    await w.flush();
    const phoneDoc = (await w.t.run(async (ctx) => ctx.db.get(phone)))!;
    expect(phoneDoc.saleQueuedAt).toBeGreaterThanOrEqual(queuedAt);
    expect(await w.momentsOf(phone)).toHaveLength(0);
    // A later reading keeps the screen's place in the queue.
    vi.setSystemTime(Date.now() + 1_000);
    await w.camera(phone, 2);
    await w.flush();
    expect((await w.t.run(async (ctx) => ctx.db.get(phone)))!.saleQueuedAt).toBe(phoneDoc.saleQueuedAt);
  });

  test("the screen running the moment never queues itself, and a screen leaves the queue when it announces", async () => {
    const w = await liveWorld();
    await w.t.run(async (ctx) => ctx.db.patch(w.led, { saleQueuedAt: START - 60_000 }));
    await w.camera(w.led, 10);
    await w.flush();
    const [m] = await w.momentsOf(w.led);
    expect(m.status).toBe("offering");
    expect((await w.t.run(async (ctx) => ctx.db.get(w.led)))!.saleQueuedAt).toBeUndefined();
    // Its own camera keeps reporting during its auction: no queueing, no new moment.
    vi.advanceTimersByTime(1_000);
    await w.camera(w.led, 12);
    await w.flush();
    expect((await w.t.run(async (ctx) => ctx.db.get(w.led)))!.saleQueuedAt).toBeUndefined();
    expect(await w.t.mutation(internal.moments.detectFor, { billboardId: w.led, trigger: "arrivals" })).toEqual({
      momentId: null,
      reason: "a moment is already in progress on this screen",
    });
    expect(await w.momentsOf(w.led)).toHaveLength(1);
  });

  test("a paid spot: the screen waits while it plays, and the next spot goes on sale 60 s before it ends", async () => {
    const w = await liveWorld();
    await w.camera(w.led, 10);
    await w.flush();
    const [m] = await w.momentsOf(w.led);
    // The winner paid: hold converted, booking confirmed, then the payment hook runs.
    const { holdId, bookingId } = await w.t.run(async (ctx) => {
      const base = { workspaceId: w.workspaceId, billboardId: w.led, slotIds: [m.slotId], amountMinor: m.priceMinor, currency: "USD" as const, traceId: `moment:${m._id}` };
      const quoteId = await ctx.db.insert("quotes", {
        ...base,
        campaignId: w.launchKit.campaignId,
        expiresAt: Date.now() + 10 * MINUTE,
        pricingBasis: ["live spot"],
        confidence: "medium",
        policyVersion: "test",
        status: "accepted",
      });
      const holdId = await ctx.db.insert("holds", {
        ...base,
        quoteId,
        expiresAt: Date.now() + 3 * MINUTE,
        status: "converted",
        idempotencyKey: `test:${m._id}`,
        actor: "agent:LaunchKit",
        agentKeyId: w.launchKit.agentKeyId,
      });
      const bookingId = await ctx.db.insert("bookings", { ...base, holdId, quoteId, campaignId: w.launchKit.campaignId, status: "confirmed" });
      await ctx.db.patch(m._id, { status: "awarded", holdId });
      await ctx.db.patch(m.slotId, { state: "booked", holdId, bookingId });
      return { holdId, bookingId };
    });
    await w.t.run(async (ctx) => onMomentPaid(ctx, holdId, bookingId, { provider: "x402", externalRef: "0xabc", network: "base-sepolia", amountMinor: m.priceMinor }));
    const paid = (await w.t.run(async (ctx) => ctx.db.get(m._id)))!;
    expect(paid.status).toBe("paid");
    const next = await w.pendingDetects();
    expect(next).toHaveLength(1);
    expect(next[0].args[0]).toEqual({ billboardId: w.led, trigger: "next_spot" });
    expect(next[0].scheduledTime).toBe(m.spotEndAt - NEXT_SPOT_LEAD_MS);

    // While the paid spot has more than 60 s left, the screen doesn't sell.
    vi.setSystemTime(m.spotStartAt + MINUTE);
    await w.camera(w.led, 10);
    expect(await w.t.mutation(internal.moments.detectFor, { billboardId: w.led, trigger: "arrivals" })).toEqual({ momentId: null, reason: "playing" });
    expect(await w.momentsOf(w.led)).toHaveLength(1);
  });

  test("no takers: re-offer about 15% lower after 20 s, then hold at the minimum", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
    const w = await liveWorld();
    await w.revokeAll();
    await w.camera(w.led, 10);
    await w.flush();
    const [first] = await w.momentsOf(w.led);
    expect(first).toMatchObject({ status: "no_takers", reofferRound: 0, floorMinor: 25 });
    expect(first.priceMinor).toBeGreaterThan(25);
    expect(await w.offersOf(first._id)).toHaveLength(0);

    vi.advanceTimersByTime(REOFFER_DELAY_MS);
    await w.t.finishInProgressScheduledFunctions();
    const second = (await w.momentsOf(w.led))[1];
    expect(second).toMatchObject({ status: "no_takers", trigger: "reoffer", reofferRound: 1, slotId: first.slotId });
    expect(second.priceMinor).toBeGreaterThanOrEqual(Math.floor(first.priceMinor * 0.85 * 0.97));
    expect(second.priceMinor).toBeLessThanOrEqual(Math.ceil(first.priceMinor * 0.85 * 1.03));
    expect(second.priceWhy).toContain("re-offer 1");

    let latest = second;
    for (let i = 0; i < 20 && latest.priceMinor !== 25; i++) {
      vi.advanceTimersByTime(REOFFER_DELAY_MS);
      await w.t.finishInProgressScheduledFunctions();
      const all = await w.momentsOf(w.led);
      const next = all[all.length - 1];
      expect(next.priceMinor).toBeLessThanOrEqual(latest.priceMinor);
      latest = next;
    }
    expect(latest.priceMinor).toBe(25);
    expect(await w.pendingDetects()).toEqual([]);
  });

  test("arrivals during the re-offer pause: same crowd holds, a real crowd change re-prices at the same round", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
    const w = await liveWorld();
    await w.revokeAll();
    await w.camera(w.led, 10);
    await w.flush();
    const [first] = await w.momentsOf(w.led);
    expect(first).toMatchObject({ status: "no_takers", reofferRound: 0, peopleInView: 10 });
    expect(await w.pendingDetects()).toHaveLength(1);

    // More arrivals, same people in view (and a change under max(2, 20%)): nothing new.
    vi.advanceTimersByTime(3_000);
    await w.camera(w.led, 10);
    await w.flush();
    expect(await w.momentsOf(w.led)).toHaveLength(1);
    await w.t.run(async (ctx) => {
      const row = (await ctx.db.query("audienceAggregates").withIndex("by_billboard_and_bucketStart", (q) => q.eq("billboardId", w.led)).first())!;
      await ctx.db.patch(row._id, { peakInView: 11 });
    });
    expect(await w.t.mutation(internal.moments.detectFor, { billboardId: w.led, trigger: "arrivals" })).toEqual({ momentId: null, reason: "holding" });
    expect(await w.momentsOf(w.led)).toHaveLength(1);
    expect(await w.pendingDetects()).toHaveLength(1);

    // The crowd jumps 10 -> 20: re-priced at the same round, no second re-offer chain.
    vi.advanceTimersByTime(2_000);
    await w.camera(w.led, 20);
    await w.flush();
    const repriced = (await w.momentsOf(w.led))[1];
    expect(repriced).toMatchObject({ status: "no_takers", trigger: "arrivals", reofferRound: 0, peopleInView: 20, slotId: first.slotId });
    expect(repriced.priceMinor).toBeGreaterThan(first.priceMinor);
    expect(await w.pendingDetects()).toHaveLength(1);

    // Only the scheduled re-offer steps the round down.
    vi.advanceTimersByTime(REOFFER_DELAY_MS);
    await w.t.finishInProgressScheduledFunctions();
    const all = await w.momentsOf(w.led);
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({ trigger: "reoffer", reofferRound: 1, peopleInView: 20 });
    expect(all[2].priceMinor).toBeLessThan(repriced.priceMinor);
    expect(await w.pendingDetects()).toHaveLength(1);
    expect((await w.t.mutation(internal.moments.detectFor, { billboardId: w.led, trigger: "arrivals" })).reason).toBe("holding");
  });

  test("no simulated, rehearsal or manual path remains", async () => {
    const w = await liveWorld();
    const exports = (m: object) => Object.keys(m);
    expect(exports(momentsModule)).not.toContain("simulateCrowd");
    expect(exports(momentsModule)).not.toContain("setRehearsalSettlement");
    expect(exports(paymentsModule)).not.toContain("recordManual");
    expect(Object.keys(modules).some((k) => /demoAgents/.test(k))).toBe(false);

    const codeOf = (e: unknown) => (e as { data?: { code?: string } }).data?.code;
    const viaAddArrivals = await w.host
      .mutation(api.audience.addArrivals, { billboardId: w.led, arrivals: 10, peakInView: 4, confidence: 1, source: "simulated" })
      .catch((e: unknown) => e);
    expect(codeOf(viaAddArrivals)).toBe("INVALID_INPUT");
    const viaRecord = await w.host
      .mutation(api.audience.record, { billboardId: w.led, countEstimate: 10, confidence: 1, source: "simulated" })
      .catch((e: unknown) => e);
    expect(codeOf(viaRecord)).toBe("INVALID_INPUT");

    const res = await w.t.fetch("/demo-agents/x/webhook", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("host controls", () => {
  test("host sets the published minimum and starting CPM", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    await w.host.mutation(api.billboards.setLivePricing, { billboardId: w.led, minimumMinor: 30, cpmMinor: 800 });
    await w.camera(w.led, 10);
    await w.flush();
    const [m] = await w.momentsOf(w.led);
    expect(m.floorMinor).toBe(30);
    expect(m.priceWhy).toContain("$8.00 per 1,000 views");
    const audits = await w.t.run(async (ctx) => ctx.db.query("auditEvents").order("desc").take(20));
    expect(audits.some((a) => a.type === "billboard.live_pricing_changed" && a.subjectId === w.led)).toBe(true);
  });

  test("setLivePricing validates its inputs and is for workspace members only", async () => {
    const w = await liveWorld();
    const set = (minimumMinor: number, cpmMinor: number) => w.host.mutation(api.billboards.setLivePricing, { billboardId: w.led, minimumMinor, cpmMinor });
    await expect(set(0, 800)).rejects.toThrow(/INVALID_INPUT/);
    await expect(set(301, 800)).rejects.toThrow(/INVALID_INPUT/);
    await expect(set(30.5, 800)).rejects.toThrow(/INVALID_INPUT/);
    await expect(set(30, 49)).rejects.toThrow(/INVALID_INPUT/);
    await expect(set(30, 100_001)).rejects.toThrow(/INVALID_INPUT/);
    await expect(
      w.launchKit.customer.mutation(api.billboards.setLivePricing, { billboardId: w.led, minimumMinor: 30, cpmMinor: 800 }),
    ).rejects.toThrow(/NOT_WORKSPACE_MEMBER/);
  });

  test("host enters the real event", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const fit = (why: string | undefined) => Number(/× (\d\.\d+) fit/.exec(why ?? "")![1]);
    await w.camera(w.led, 10);
    await w.flush();
    const [before] = await w.momentsOf(w.led);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(before._id, { status: "failed" });
      await ctx.db.patch(before.slotId, { state: "booked" });
    });
    const now = Date.now();
    const { eventId } = await w.host.mutation(api.events.create, {
      billboardId: w.led,
      name: "Startup demo day",
      startsAt: now - 10 * MINUTE,
      endsAt: now + 60 * MINUTE,
      audienceTags: { startups: 1 },
    });
    const ev = await w.t.run(async (ctx) => ctx.db.get(eventId));
    expect(ev?.source).toBe("host");
    await w.camera(w.led, 10);
    await w.flush();
    const all = await w.momentsOf(w.led);
    const after = all[all.length - 1];
    expect(after._id).not.toBe(before._id);
    expect(fit(after.priceWhy)).toBeGreaterThan(fit(before.priceWhy));
    await expect(
      w.launchKit.customer.mutation(api.events.create, { billboardId: w.led, name: "x", startsAt: now, endsAt: now + MINUTE }),
    ).rejects.toThrow(/NOT_WORKSPACE_MEMBER/);
  });
});

describe("live auction lifecycle", () => {
  test("two companies: auction rises in 5¢ steps, highest bid wins and gets a hold", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
    const w = await liveWorld();
    const { m, lk, rv } = await w.auction();
    expect(m.status).toBe("bidding");
    expect(m.extensions).toBe(0);
    expect(m.hardClosesAt).toBe(m.biddingClosesAt! + MAX_EXTENSIONS * EXTENSION_MS);
    expect(m.biddingClosesAt! - Date.now()).toBeLessThanOrEqual(BIDDING_MS);
    expect(m.biddingClosesAt! - Date.now()).toBeGreaterThan(BIDDING_MS - 3_000);

    const O = m.priceMinor;
    const b2 = minNextLiveBid({ leaderMinor: O, openingMinor: O });
    const b3 = minNextLiveBid({ leaderMinor: b2, openingMinor: O });
    expect(b2 - O).toBe(5);
    expect(b3 - b2).toBe(5);
    const first = await w.bid(w.launchKit, lk, O);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ offerId: lk, currentMinor: O, youLead: true, bidsLeft: 4 });
    expect((await w.bid(w.rivet, rv, b2)).status).toBe(200);
    expect((await w.bid(w.launchKit, lk, b3)).status).toBe(200);
    await w.flush();
    const mid = await w.momentDoc(m._id);
    expect(mid).toMatchObject({ currentMinor: b3, leaderOfferId: lk });

    await w.advance(mid.biddingClosesAt! - Date.now() + 1);
    const done = await w.momentDoc(m._id);
    expect(done.status).toBe("awarded");
    expect(done.winnerOfferId).toBe(lk);
    const hold = (await w.t.run(async (ctx) => ctx.db.get(done.holdId!)))!;
    expect(hold.amountMinor).toBe(b3);
    const bids = await w.bidsOf(m._id);
    expect(bids).toHaveLength(3);
    expect(bids.every((b) => b.kind === "bid")).toBe(true);
    expect(bids.map((b) => b.amountMinor)).toEqual([O, b2, b3]);
  });

  test("bid rules: too low, sixth bid, leader can't raise, closed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    // Generous limits so ten rising bids stay within the standing instructions.
    const generous = { maxPricePerSpotMinor: 5_000, minRelevantViewers: 3, dailyBudgetMinor: 50_000 };
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.launchKit.agentKeyId, { standing: generous });
      await ctx.db.patch(w.rivet.agentKeyId, { standing: generous });
    });
    const { m, lk, rv } = await w.auction();
    const O = m.priceMinor;
    const low = await w.bid(w.rivet, rv, O - 1);
    expect(low.status).toBe(409);
    expect(low.body.error.code).toBe("BID_TOO_LOW");

    expect((await w.bid(w.launchKit, lk, O)).status).toBe(200);
    const leading = await w.bid(w.launchKit, lk, minNextLiveBid({ leaderMinor: O, openingMinor: O }));
    expect(leading.status).toBe(409);
    expect(leading.body.error.code).toBe("ALREADY_LEADING");

    // Review Focus 3: the same amount back to back from two companies: the second is too low.
    const same = minNextLiveBid({ leaderMinor: O, openingMinor: O });
    expect((await w.bid(w.rivet, rv, same)).status).toBe(200);
    const dup = await w.bid(w.launchKit, lk, same);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("BID_TOO_LOW");

    // Each company has 5 bids: after 5 each, the sixth is refused.
    let leader = same;
    for (let i = 0; i < 8; i++) {
      const [who, offerId] = i % 2 === 0 ? [w.launchKit, lk] : [w.rivet, rv];
      leader = minNextLiveBid({ leaderMinor: leader, openingMinor: O });
      const res = await w.bid(who, offerId, leader);
      expect(res.status).toBe(200);
    }
    const offers = await w.offersOf(m._id);
    expect(offers.map((o) => o.bidCount)).toEqual([5, 5]);
    const sixth = await w.bid(w.launchKit, lk, minNextLiveBid({ leaderMinor: leader, openingMinor: O }));
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe("BID_LIMIT");

    // After the close, nobody can bid.
    const closesAt = (await w.momentDoc(m._id)).biddingClosesAt!;
    vi.setSystemTime(closesAt);
    await w.t.run(async (ctx) => ctx.db.patch(lk, { bidCount: 0 }));
    const closed = await w.bid(w.launchKit, lk, minNextLiveBid({ leaderMinor: leader, openingMinor: O }));
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("BIDDING_CLOSED");
  });

  test("late bids extend by 3 s, at most twice", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk, rv } = await w.auction();
    const O = m.priceMinor;
    const closes: number[] = [m.biddingClosesAt!];
    let amount = O;
    const turns = [
      [w.launchKit, lk],
      [w.rivet, rv],
      [w.launchKit, lk],
    ] as const;
    for (const [who, offerId] of turns) {
      vi.setSystemTime(closes[closes.length - 1] - 1_000);
      const res = await w.bid(who, offerId, amount);
      expect(res.status).toBe(200);
      closes.push((await w.momentDoc(m._id)).biddingClosesAt!);
      amount = minNextLiveBid({ leaderMinor: amount, openingMinor: O });
    }
    expect(closes.slice(1).map((c, i) => c - closes[i])).toEqual([EXTENSION_MS, EXTENSION_MS, 0]);
    const after = await w.momentDoc(m._id);
    expect(after.extensions).toBe(2);
    expect(after.biddingClosesAt).toBe(after.hardClosesAt);
    // A close that runs before the extended time does nothing; after it, the leader wins.
    await w.t.mutation(internal.liveAuction.closeBidding, { momentId: m._id });
    expect((await w.momentDoc(m._id)).status).toBe("bidding");
    await w.advance(20_000);
    const done = await w.momentDoc(m._id);
    expect(done.status).toBe("awarded");
    expect(done.winnerOfferId).toBe(lk);
  });

  test("exactly one taker: sold at the opening price without bidding", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk, rv } = await w.announce();
    expect((await w.reply(w.launchKit, lk, "accept")).status).toBe(200);
    expect((await w.reply(w.rivet, rv, "pass")).status).toBe(200);
    await w.flush();
    const done = await w.momentDoc(m._id);
    expect(done.status).toBe("awarded");
    expect(done.winnerOfferId).toBe(lk);
    expect(done.biddingClosesAt).toBeUndefined();
    expect(done.steps.some((s) => s.key === "auction_started")).toBe(false);
    const hold = (await w.t.run(async (ctx) => ctx.db.get(done.holdId!)))!;
    expect(hold.amountMinor).toBe(m.priceMinor);
    expect(await w.bidsOf(m._id)).toHaveLength(0);
  });

  test("only counters: negotiation never goes below the minimum", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk, rv } = await w.announce();
    const O = m.priceMinor;
    expect((await w.reply(w.launchKit, lk, "counter", 40)).status).toBe(200);
    expect((await w.reply(w.rivet, rv, "pass")).status).toBe(200);
    await w.flush();
    const s1 = O - Math.round((O - 40) * 0.35);
    let n = await w.momentDoc(m._id);
    expect(n).toMatchObject({ status: "negotiating", negotiationOfferId: lk, negotiationRound: 1, sellerMinor: s1 });
    expect((await w.bidsOf(m._id)).map((b) => [b.kind, b.amountMinor])).toEqual([
      ["buyer_offer", 40],
      ["seller_counter", s1],
    ]);

    const second = await w.reply(w.launchKit, lk, "counter", 55);
    expect(second.status).toBe(200);
    const s2 = s1 - Math.round((s1 - 55) * 0.25);
    n = await w.momentDoc(m._id);
    expect(n).toMatchObject({ status: "negotiating", negotiationRound: 2, sellerMinor: s2 });
    // Another company can't jump in.
    expect((await w.reply(w.rivet, rv, "accept")).status).toBe(409);

    expect((await w.reply(w.launchKit, lk, "accept")).status).toBe(200);
    await w.flush();
    const done = await w.momentDoc(m._id);
    expect(done.status).toBe("awarded");
    expect(done.winnerOfferId).toBe(lk);
    const hold = (await w.t.run(async (ctx) => ctx.db.get(done.holdId!)))!;
    expect(hold.amountMinor).toBe(s2);
  });

  test("a negotiation counter at or above the host's price is an accept at the host's price", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk, rv } = await w.announce();
    await w.reply(w.launchKit, lk, "counter", 40);
    await w.reply(w.rivet, rv, "pass");
    const s1 = (await w.momentDoc(m._id)).sellerMinor!;
    const res = await w.reply(w.launchKit, lk, "counter", s1 + 30);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ offerId: lk, status: "won", amountMinor: s1 });
    const done = await w.momentDoc(m._id);
    expect(done.status).toBe("awarded");
    expect((await w.t.run(async (ctx) => ctx.db.get(done.holdId!)))!.amountMinor).toBe(s1);
    const audits = await w.t.run(async (ctx) => ctx.db.query("auditEvents").order("desc").take(30));
    const agreed = `negotiation accept $${(s1 / 100).toFixed(2)}`;
    expect(audits.some((a) => a.type === "moment.reply" && a.reason.startsWith(agreed))).toBe(true);
  });

  test("final negotiation round below the minimum: no takers, and the host is free", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk, rv } = await w.announce();
    expect((await w.reply(w.launchKit, lk, "counter", 40)).status).toBe(200);
    expect((await w.reply(w.rivet, rv, "pass")).status).toBe(200);
    for (const amount of [41, 42]) {
      expect((await w.reply(w.launchKit, lk, "counter", amount)).status).toBe(200);
      expect((await w.momentDoc(m._id)).status).toBe("negotiating");
    }
    expect((await w.reply(w.launchKit, lk, "counter", 20)).status).toBe(200);
    const done = await w.momentDoc(m._id);
    expect(done.status).toBe("no_takers");
    expect(done.negotiationRound).toBe(4);
    expect(m.priceMinor).toBeGreaterThan(m.floorMinor);
    expect((await w.pendingDetects()).some((s) => s.args[0].trigger === "reoffer")).toBe(true);
    // Nothing else runs on this host, so another screen can sell straight away.
    expect(await w.t.run(async (ctx) => momentsModule.workspaceBusy(ctx, w.workspaceId))).toBeNull();
  });

  test("a negotiation that runs out of time ends with no takers", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk, rv } = await w.announce();
    await w.reply(w.launchKit, lk, "counter", 40);
    await w.reply(w.rivet, rv, "pass");
    await w.flush();
    expect((await w.momentDoc(m._id)).status).toBe("negotiating");
    await w.advance(18_000);
    expect((await w.momentDoc(m._id)).status).toBe("no_takers");
    const late = await w.reply(w.launchKit, lk, "accept");
    expect(late.status).toBe(409);
  });

  test("winner who doesn't pay in 60 s: runner-up at its last bid", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk, rv } = await w.auction();
    const O = m.priceMinor;
    const b2 = minNextLiveBid({ leaderMinor: O, openingMinor: O });
    const b3 = minNextLiveBid({ leaderMinor: b2, openingMinor: O });
    await w.bid(w.launchKit, lk, O);
    await w.bid(w.rivet, rv, b2);
    await w.bid(w.launchKit, lk, b3);
    await w.advance((await w.momentDoc(m._id)).biddingClosesAt! - Date.now() + 1);
    expect((await w.momentDoc(m._id)).winnerOfferId).toBe(lk);

    await w.advance(60_000);
    const after = await w.momentDoc(m._id);
    expect(after.status).toBe("awarded");
    expect(after.winnerOfferId).toBe(rv);
    const offers = await w.offersOf(m._id);
    expect(offers.find((o) => o._id === rv)!.status).toBe("won");
    expect(offers.find((o) => o._id === lk)!.status).toBe("defaulted");
    const hold = (await w.t.run(async (ctx) => ctx.db.get(after.holdId!)))!;
    expect(hold.amountMinor).toBe(b2);
    const exceptions = await w.t.run(async (ctx) => ctx.db.query("financeExceptions").take(10));
    expect(exceptions.some((e) => e.kind === "winner_default")).toBe(true);

    // Rivet doesn't pay either: nobody is left, the moment fails and the host is free.
    await w.advance(60_000);
    expect((await w.momentDoc(m._id)).status).toBe("failed");
    expect(await w.t.run(async (ctx) => momentsModule.workspaceBusy(ctx, w.workspaceId))).toBeNull();
  });

  test("the queue drains when the host is free", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const phone = await w.addScreen("Phone");
    const { m, lk, rv } = await w.announce();
    await w.camera(phone, 10);
    await w.flush();
    expect((await w.t.run(async (ctx) => ctx.db.get(phone)))!.saleQueuedAt).toBeDefined();
    expect(await w.momentsOf(phone)).toHaveLength(0);

    await w.reply(w.launchKit, lk, "pass");
    await w.reply(w.rivet, rv, "pass");
    expect((await w.momentDoc(m._id)).status).toBe("no_takers");
    // R13: dequeued, but it keeps its place until it actually announces.
    expect((await w.t.run(async (ctx) => ctx.db.get(phone)))!.saleQueuedAt).toBeDefined();
    await w.flush();
    const phoneMoments = await w.momentsOf(phone);
    expect(phoneMoments).toHaveLength(1);
    expect(phoneMoments[0]).toMatchObject({ trigger: "queue", status: "offering" });
    expect((await w.t.run(async (ctx) => ctx.db.get(phone)))!.saleQueuedAt).toBeUndefined();
  });

  test("a re-offer that comes due while another screen sells waits in the queue, then resumes", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const phone = await w.addScreen("Phone");
    const led = await w.announce();
    await w.reply(w.launchKit, led.lk, "pass");
    await w.reply(w.rivet, led.rv, "pass");
    await w.flush();
    expect((await w.momentDoc(led.m._id)).status).toBe("no_takers");

    // The phone sells next, and its winner is still paying when the LED's re-offer comes due.
    const ph = await w.announce(phone);
    await w.t.run(async (ctx) => ctx.db.patch(ph.m._id, { status: "awarded" }));
    await w.advance(REOFFER_DELAY_MS);
    expect(await w.momentsOf(w.led)).toHaveLength(1);
    expect((await w.t.run(async (ctx) => ctx.db.get(w.led)))!.saleQueuedAt).toBeDefined();

    // The phone's spot is paid: the LED leaves the queue, same crowd, so its re-offer chain restarts.
    await w.t.run(async (ctx) => {
      await ctx.db.patch(ph.m._id, { status: "paid" });
      await releaseWorkspace(ctx, w.workspaceId);
    });
    await w.flush();
    expect(await w.momentsOf(w.led)).toHaveLength(1);
    expect((await w.pendingDetects()).filter((s) => s.args[0].billboardId === w.led && s.args[0].trigger === "reoffer")).toHaveLength(1);
    await w.advance(REOFFER_DELAY_MS);
    const all = await w.momentsOf(w.led);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ trigger: "reoffer", reofferRound: 1, status: "offering" });
    expect(all[1].priceMinor).toBeLessThan(led.m.priceMinor);
  });

  test("a paid winner frees the host: the queued screen sells next", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const phone = await w.addScreen("Phone");
    const { m, lk } = await w.announce();
    await w.reply(w.launchKit, lk, "accept");
    await w.advance(2_000); // Rivet never answers: sold to LaunchKit at the opening price
    const sold = await w.momentDoc(m._id);
    expect(sold.status).toBe("awarded");
    await w.camera(phone, 10);
    await w.flush();
    expect(await w.momentsOf(phone)).toHaveLength(0);
    // Settle the hold as the payment route would, then the payment hook runs.
    await w.t.run(async (ctx) => {
      const hold = (await ctx.db.get(sold.holdId!))!;
      await ctx.db.patch(hold._id, { status: "converted" });
      const bookingId = await ctx.db.insert("bookings", {
        workspaceId: w.workspaceId,
        billboardId: w.led,
        slotIds: hold.slotIds,
        amountMinor: hold.amountMinor,
        currency: "USD",
        traceId: hold.traceId,
        holdId: hold._id,
        quoteId: hold.quoteId,
        campaignId: w.launchKit.campaignId,
        status: "confirmed",
      });
      await onMomentPaid(ctx, hold._id, bookingId, { provider: "x402", externalRef: "0xabc", amountMinor: hold.amountMinor });
    });
    await w.flush();
    const phoneMoments = await w.momentsOf(phone);
    expect(phoneMoments).toHaveLength(1);
    expect(phoneMoments[0].trigger).toBe("queue");
  });

  test("an auction nobody bids in is sold to the earliest joiner at the opening price (R12)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk, rv } = await w.auction(); // LaunchKit accepted first
    await w.advance(m.biddingClosesAt! - Date.now() + 1);
    const done = await w.momentDoc(m._id);
    expect(done.status).toBe("awarded");
    expect(done.winnerOfferId).toBe(lk);
    const hold = (await w.t.run(async (ctx) => ctx.db.get(done.holdId!)))!;
    expect(hold.amountMinor).toBe(m.priceMinor);
    expect((await w.offersOf(m._id)).find((o) => o._id === rv)!.status).toBe("lost");
    expect(await w.bidsOf(m._id)).toHaveLength(0);
    expect((await w.pendingDetects()).some((s) => s.args[0].trigger === "reoffer")).toBe(false);
  });

  test("the spot can't be held: the moment fails, every joiner hears it lost, and the host is free", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk, rv } = await w.announce();
    await w.t.run(async (ctx) => ctx.db.patch(m.slotId, { state: "booked" }));
    await w.reply(w.rivet, rv, "counter", 60);
    await w.reply(w.launchKit, lk, "accept"); // one taker: sale, but the hold fails
    const done = await w.momentDoc(m._id);
    expect(done.status).toBe("failed");
    const offers = await w.offersOf(m._id);
    expect(offers.map((o) => o.status)).toEqual(["lost", "lost"]);
    await w.flush();
    const lost = vi
      .mocked(fetch)
      .mock.calls.filter(([url, init]) => String(url).startsWith("https://agent.test/") && (init?.headers as Record<string, string>)["X-BillboardOS-Event"] === "flash_lost");
    expect(lost.map(([url]) => String(url)).sort()).toEqual(["https://agent.test/launchkit", "https://agent.test/rivet"]);
    expect(await w.t.run(async (ctx) => momentsModule.workspaceBusy(ctx, w.workspaceId))).toBeNull();
  });

  test("webhooks: offer carries the price story; auction events reach every participant", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk, rv } = await w.auction();
    const offer = await w.t.query(internal.momentDelivery.loadForDelivery, { offerId: lk, event: "flash_offer" });
    expect(offer.ok && offer.payload).toMatchObject({
      type: "flash_offer",
      valueMinor: m.valueMinor,
      openingMinor: m.priceMinor,
      minimumMinor: m.floorMinor,
      why: m.priceWhy,
    });
    const started = await w.t.query(internal.momentDelivery.loadForDelivery, { offerId: lk, event: "auction_started" });
    expect(started.ok && started.payload).toMatchObject({
      type: "auction_started",
      openingMinor: m.priceMinor,
      minNextMinor: m.priceMinor,
      closesAt: m.biddingClosesAt,
      bidsLeft: 5,
      participants: 2,
      links: { bid: `/api/agent/offers/${lk}/bid` },
    });
    await w.bid(w.launchKit, lk, m.priceMinor);
    const mine = await w.t.query(internal.momentDelivery.loadForDelivery, { offerId: lk, event: "auction_update" });
    expect(mine.ok && mine.payload).toMatchObject({ type: "auction_update", currentMinor: m.priceMinor, youLead: true, bidsLeft: 4, lastBidBy: "you" });
    // The rival learns the price, never who bid.
    const rival = await w.t.query(internal.momentDelivery.loadForDelivery, { offerId: rv, event: "auction_update" });
    expect(rival.ok && rival.payload).toMatchObject({ type: "auction_update", currentMinor: m.priceMinor, youLead: false, bidsLeft: 5, lastBidBy: "another company" });
    const rivalText = JSON.stringify(rival.ok && rival.payload);
    expect(rivalText).not.toContain("LaunchKit");
    expect(rivalText).not.toContain(w.launchKit.advertiserId);
    expect(rivalText).not.toContain(lk);
    // A bid needs an amount.
    const noAmount = await w.agent(w.rivet, `offers/${rv}/bid`, {});
    expect(noAmount.status).toBe(400);
    const fetchMock = vi.mocked(fetch);
    await w.flush();
    const events = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith("https://agent.test/"))
      .map(([, init]) => (init?.headers as Record<string, string>)["X-BillboardOS-Event"]);
    expect(events.filter((e) => e === "auction_started")).toHaveLength(2);
    expect(events.filter((e) => e === "auction_update")).toHaveLength(2);
  });
});

describe("display", () => {
  test("screenState follows the moment: announce → auction (ladder) → playing", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const idle = await w.t.query(api.player.screenState, { billboardId: w.led });
    expect(idle.mode).toBe("your_ad_here");
    expect(idle.ladder).toHaveLength(0);

    const { m, lk, rv } = await w.announce();
    const announced = await w.t.query(api.player.screenState, { billboardId: w.led });
    expect(announced.mode).toBe("announce");
    expect(announced.ladder).toHaveLength(0);
    expect(announced.openingMinor).toBe(m.priceMinor);
    expect(announced.minimumMinor).toBe(m.floorMinor);
    expect(announced.screenName).toBe("LED");
    expect(announced.nowPlaying).toBeNull();

    await w.reply(w.launchKit, lk, "accept");
    await w.reply(w.rivet, rv, "accept");
    await w.advance(2_000);
    const open = await w.momentDoc(m._id);
    expect(open.status).toBe("bidding");
    const O = open.priceMinor;
    const b2 = minNextLiveBid({ leaderMinor: O, openingMinor: O });
    await w.bid(w.launchKit, lk, O);
    await w.bid(w.rivet, rv, b2);
    await w.flush();
    const auction = await w.t.query(api.player.screenState, { billboardId: w.led });
    expect(auction.mode).toBe("auction");
    expect(auction.ladder).toHaveLength(2);
    expect(auction.ladder[0]).toMatchObject({ company: "Rivet", amountMinor: b2, leading: true });
    expect(auction.ladder[1]).toMatchObject({ company: "LaunchKit", amountMinor: O, leading: false });
    expect(auction.closesAt).toBe((await w.momentDoc(m._id)).biddingClosesAt);

    // A late bid extends the auction: closesAt moves in screenState.
    const before = auction.closesAt!;
    vi.setSystemTime(before - 1_000);
    expect((await w.bid(w.launchKit, lk, minNextLiveBid({ leaderMinor: b2, openingMinor: O }))).status).toBe(200);
    await w.flush();
    const extended = await w.t.query(api.player.screenState, { billboardId: w.led });
    expect(extended.closesAt).toBe(before + EXTENSION_MS);

    await w.advance(extended.closesAt! + 10_000 - Date.now());
    const awarded = await w.momentDoc(m._id);
    expect(awarded.status).toBe("awarded");
    const settling = await w.t.query(api.player.screenState, { billboardId: w.led });
    expect(settling.mode).toBe("settling");
    expect(settling.nowPlaying).toMatchObject({ company: "LaunchKit", txShort: null, txUrl: null });
    await w.t.run(async (ctx) => {
      const hold = (await ctx.db.get(awarded.holdId!))!;
      await ctx.db.patch(hold._id, { status: "converted" });
      const bookingId = await ctx.db.insert("bookings", {
        workspaceId: w.workspaceId,
        billboardId: w.led,
        slotIds: hold.slotIds,
        amountMinor: hold.amountMinor,
        currency: "USD",
        traceId: hold.traceId,
        holdId: hold._id,
        quoteId: hold.quoteId,
        campaignId: w.launchKit.campaignId,
        status: "confirmed",
      });
      await onMomentPaid(ctx, hold._id, bookingId, { provider: "x402", externalRef: `0x${"ab".repeat(32)}`, network: "eip155:84532", amountMinor: hold.amountMinor });
    });
    const playing = await w.t.query(api.player.screenState, { billboardId: w.led });
    expect(playing.mode).toBe("playing");
    expect(playing.spotEndAt).toBe(awarded.spotEndAt);
    expect(playing.nowPlaying).toMatchObject({ company: "LaunchKit", wonAtMinor: awarded.currentMinor, txShort: "0xabab…abab" });
    expect(playing.nowPlaying?.txUrl).toBe(`https://sepolia.basescan.org/tx/0x${"ab".repeat(32)}`);
  });
});

describe("display without a transaction", () => {
  test("a paid moment with no settlement tx shows no proof of payment", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk } = await w.announce();
    await w.reply(w.launchKit, lk, "accept");
    await w.advance(2_000);
    await w.t.run(async (ctx) => ctx.db.patch(m._id, { status: "paid", paidMinor: 40 }));
    const s = await w.t.query(api.player.screenState, { billboardId: w.led });
    expect(s.mode).toBe("playing");
    expect(s.nowPlaying).toMatchObject({ company: "LaunchKit", wonAtMinor: 40, txShort: null, txUrl: null });
  });
});

describe("one re-offer chain per screen", () => {
  const reoffersFor = async (w: Awaited<ReturnType<typeof liveWorld>>, billboardId: Id<"billboards">) =>
    (await w.pendingDetects()).filter((s) => s.args[0].billboardId === billboardId && s.args[0].trigger === "reoffer");

  test("a re-priced spot whose live moment ends with no takers keeps one chain", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    // 10 people: ~5 relevant, under both reach targets; 20 people: ~10, enough.
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.launchKit.agentKeyId, { standing: { ...STANDING, minRelevantViewers: 8 } });
      await ctx.db.patch(w.rivet.agentKeyId, { standing: { ...STANDING, minRelevantViewers: 8 } });
    });
    await w.camera(w.led, 10);
    await w.flush();
    const [first] = await w.momentsOf(w.led);
    expect(first.status).toBe("no_takers");
    expect(await reoffersFor(w, w.led)).toHaveLength(1);

    vi.advanceTimersByTime(3_000);
    const { m, lk, rv } = await w.announce(w.led, 20);
    expect(m).toMatchObject({ status: "offering", trigger: "arrivals", reofferRound: 0 });
    await w.reply(w.launchKit, lk, "pass");
    await w.reply(w.rivet, rv, "pass");
    expect((await w.momentDoc(m._id)).status).toBe("no_takers");
    expect(await reoffersFor(w, w.led)).toHaveLength(1);

    // The one chain steps down once.
    await w.advance(REOFFER_DELAY_MS);
    const all = await w.momentsOf(w.led);
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({ trigger: "reoffer", reofferRound: 1 });
    expect(await reoffersFor(w, w.led)).toHaveLength(0); // it found takers: offering, no chain
  });

  test("a queued screen holding with a re-offer still pending doesn't start another", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const phone = await w.addScreen("Phone");
    await w.revokeAll();
    await w.camera(w.led, 10);
    await w.flush();
    const [waiting] = await w.momentsOf(w.led);
    expect(waiting.status).toBe("no_takers");
    expect(await reoffersFor(w, w.led)).toHaveLength(1);

    // The phone's winner is paying (host busy); the LED's camera reports the same crowd and queues.
    const busyId = await w.t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = waiting;
      void _id;
      void _creationTime;
      return await ctx.db.insert("moments", { ...rest, billboardId: phone, status: "awarded" });
    });
    vi.advanceTimersByTime(2_000);
    await w.camera(w.led, 10);
    await w.flush();
    expect((await w.t.run(async (ctx) => ctx.db.get(w.led)))!.saleQueuedAt).toBeDefined();

    await w.t.run(async (ctx) => {
      await ctx.db.patch(busyId, { status: "paid" });
      await releaseWorkspace(ctx, w.workspaceId);
    });
    await w.flush();
    expect(await w.momentsOf(w.led)).toHaveLength(1); // holding
    expect(await reoffersFor(w, w.led)).toHaveLength(1);
    // It passed its turn: out of the queue.
    expect((await w.t.run(async (ctx) => ctx.db.get(w.led)))!.saleQueuedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------- company agents (server-run)

const AGENT_SETUP = { targetAudience: { startups: 1, software: 0.5 }, minRelevantViewers: 3, maxPerSpotMinor: 150, dailyBudgetMinor: 500 };

/**
 * liveWorld, but both companies bid through their server-run company agent,
 * set up on the website (`companyAgents.setup`). The hand-issued keys are revoked.
 */
async function liveWorldWithAgents() {
  const w = await liveWorld();
  await w.revokeAll();
  type Company = typeof w.launchKit;
  for (const c of [w.launchKit, w.rivet]) {
    await c.customer.mutation(api.companyAgents.setup, { campaignId: c.campaignId, ...AGENT_SETUP });
  }
  await w.flush(); // ensureWallet runs: no CDP keys here

  async function agentRow(c: Company) {
    return (await w.t.run(async (ctx) =>
      ctx.db
        .query("companyAgents")
        .withIndex("by_advertiser", (q) => q.eq("advertiserId", c.advertiserId))
        .first(),
    ))!;
  }
  /** The agent's plaintext key, as only our server can read it. */
  async function agentKey(c: Company) {
    const row = await agentRow(c);
    return await decryptSecret(SECRET, row.keyCiphertext, row.keyIv);
  }
  async function setBalance(c: Company, balanceMinor: number) {
    const row = await agentRow(c);
    await w.t.run(async (ctx) => ctx.db.patch(row._id, { balanceMinor }));
  }
  /**
   * Run scheduled functions and timers to completion, in time order: what is
   * due now runs first (webhooks, agents' replies and bids), then the clock
   * moves to the next scheduled function (join close, bidding close, pay deadline).
   */
  async function runAll(maxSteps = 60) {
    for (let i = 0; i < maxSteps; i++) {
      await w.flush();
      const pending = (await w.t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((s) => s.state.kind === "pending");
      if (pending.length === 0) return;
      const next = Math.min(...pending.map((s) => s.scheduledTime));
      vi.advanceTimersByTime(Math.max(1, next - Date.now()));
      await w.t.finishInProgressScheduledFunctions();
    }
    throw new Error("scheduled functions never settled");
  }
  return { ...w, agentRow, agentKey, setBalance, runAll };
}

describe("company agents", () => {
  beforeEach(() => {
    process.env.COMPANY_AGENT_DELAY_MS = "0";
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    delete process.env.CDP_WALLET_SECRET;
  });
  afterEach(() => {
    delete process.env.COMPANY_AGENT_DELAY_MS;
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    delete process.env.CDP_WALLET_SECRET;
  });

  /** LaunchKit already committed `amountMinor` today, through one of its agent keys. */
  async function committedToday(w: Awaited<ReturnType<typeof liveWorldWithAgents>>, agentKeyId: Id<"agentKeys">, amountMinor: number) {
    await w.t.run(async (ctx) => {
      const slot = (await ctx.db
        .query("slots")
        .withIndex("by_billboard_and_startAt", (q) => q.eq("billboardId", w.led))
        .order("desc")
        .first())!;
      const quoteId = await ctx.db.insert("quotes", {
        workspaceId: w.workspaceId,
        campaignId: w.launchKit.campaignId,
        billboardId: w.led,
        slotIds: [slot._id],
        amountMinor,
        currency: "USD",
        expiresAt: Date.now() + 60_000,
        pricingBasis: ["earlier spot today"],
        confidence: "medium",
        policyVersion: "test",
        status: "open",
        traceId: "test:earlier",
        agentKeyId,
      });
      await ctx.db.insert("holds", {
        workspaceId: w.workspaceId,
        quoteId,
        billboardId: w.led,
        slotIds: [slot._id],
        amountMinor,
        currency: "USD",
        expiresAt: Date.now() + 60_000,
        status: "converted",
        idempotencyKey: `test:earlier:${agentKeyId}`,
        actor: "test",
        traceId: "test:earlier",
        agentKeyId,
      });
    });
  }

  test("turning the agent off and on doesn't reset today's budget", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorldWithAgents();
    await w.setBalance(w.launchKit, 500);
    await w.setBalance(w.rivet, 500);
    // $4.50 of LaunchKit's $5.00 daily budget is already spent, under its first key.
    const firstKey = (await w.agentRow(w.launchKit)).agentKeyId;
    await committedToday(w, firstKey, 450);
    await w.launchKit.customer.mutation(api.companyAgents.setEnabled, { enabled: false });
    await w.launchKit.customer.mutation(api.companyAgents.setEnabled, { enabled: true });
    const row = await w.agentRow(w.launchKit);
    expect(row.agentKeyId).not.toBe(firstKey);
    const newKey = await w.agentKey(w.launchKit);

    // Shown and used per company: the fresh key starts at $4.50 spent, not $0.
    expect((await w.launchKit.customer.query(api.companyAgents.mine, {}))!.spentTodayMinor).toBe(450);
    const me = await w.t.query(internal.companyAgents.forAct, { advertiserId: w.launchKit.advertiserId, now: Date.now() });
    expect(me!.spentTodayMinor).toBe(450);

    // The camera announces (detect runs; the webhooks haven't been delivered yet).
    await w.camera(w.led, 10);
    vi.advanceTimersByTime(1);
    await w.t.finishInProgressScheduledFunctions();
    const [m] = await w.momentsOf(w.led);
    expect(m.priceMinor).toBeGreaterThan(50);
    const lk = (await w.offersOf(m._id)).find((o) => o.advertiserId === w.launchKit.advertiserId)!;
    expect(lk.status).toBe("sent");
    // Server side: the new key can't accept the opening price, it is over the company's daily budget.
    const refused = await w.t.fetch(`/api/agent/offers/${lk._id}/reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${newKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "accept" }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({
      code: "STANDING_INSTRUCTIONS",
      message: expect.stringContaining("daily budget"),
    });
    // Agent side: its cap is the $0.50 left, so it counters at or under it.
    await w.flush();
    const replies = (await w.t.run(async (ctx) => ctx.db.query("auditEvents").take(500))).filter((a) => a.type === "moment.reply" && a.subjectId === lk._id);
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies.every((a) => /^countered \$0\.[0-4]\d|^countered \$0\.50/.test(a.reason))).toBe(true);
    expect((await w.offersOf(m._id)).find((o) => o._id === lk._id)!.replyAmountMinor!).toBeLessThanOrEqual(50);

    // With $4.90 spent, the company isn't even offered a spot at the $0.25 minimum.
    await committedToday(w, row.agentKeyId, 40);
    await w.runAll();
    vi.advanceTimersByTime(60_000);
    await w.t.run(async (ctx) => {
      const slots = await ctx.db.query("slots").take(200);
      for (const sl of slots) if (sl.state !== "available") await ctx.db.patch(sl._id, { state: "available", holdId: undefined });
    });
    await w.camera(w.led, 12);
    await w.runAll();
    const all = await w.momentsOf(w.led);
    const latest = all[all.length - 1];
    expect(latest._id).not.toBe(m._id);
    expect((await w.offersOf(latest._id)).some((o) => o.advertiserId === w.launchKit.advertiserId)).toBe(false);
    expect(latest.steps.find((st) => st.key === "targeted")!.detail).toContain("daily budget exhausted");
  });

  test("the wallet faucet is claimed at most once a day per company, however often the agent is set up", async () => {
    process.env.CDP_API_KEY_ID = "test-id";
    process.env.CDP_API_KEY_SECRET = "test-secret";
    process.env.CDP_WALLET_SECRET = "test-wallet-secret";
    cdpFake.faucetClaims = [];
    cdpFake.usdcAtomic = 0n; // under $1: the agent wants the faucet
    const w = await liveWorldWithAgents(); // setup ran ensureWallet once for each company
    const lkClaims = () => cdpFake.faucetClaims.filter((c) => c.startsWith("usdc:")).length;
    expect(lkClaims()).toBe(2); // one per company
    const before = await w.agentRow(w.launchKit);
    expect(before.walletAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(before.balanceMinor).toBe(0);
    expect(before.faucetClaimedAt).toBeDefined();

    // Setting up again and toggling off/on schedule ensureWallet again, but never claim again today.
    await w.launchKit.customer.mutation(api.companyAgents.setup, { campaignId: w.launchKit.campaignId, ...AGENT_SETUP });
    await w.launchKit.customer.mutation(api.companyAgents.setEnabled, { enabled: false });
    await w.launchKit.customer.mutation(api.companyAgents.setEnabled, { enabled: true });
    await w.flush();
    expect(lkClaims()).toBe(2);
    expect((await w.agentRow(w.launchKit)).lastAction).toContain("faucet already claimed");

    // A day later it may claim again.
    vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
    await w.t.action(internal.companyAgentsNode.ensureWallet, { advertiserId: w.launchKit.advertiserId });
    expect(lkClaims()).toBe(3);
  });

  /** liveWorld with LaunchKit's agent set up, but offers still going to the hand-issued keys: LaunchKit wins a sale. */
  async function wonSale() {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    await w.launchKit.customer.mutation(api.companyAgents.setup, { campaignId: w.launchKit.campaignId, ...AGENT_SETUP });
    await w.flush();
    const { m, lk, rv } = await w.announce();
    await w.reply(w.launchKit, lk, "accept");
    await w.reply(w.rivet, rv, "pass");
    const sold = await w.momentDoc(m._id);
    expect(sold.status).toBe("awarded");
    const hold = (await w.t.run(async (ctx) => ctx.db.get(sold.holdId!)))!;
    const won = { type: "flash_won", offerId: lk, holdId: hold._id, amountMinor: hold.amountMinor, purchaseUrl: `${SITE}/a2a/hosts/${w.workspaceId}/purchases/${hold._id}` };
    return { w, m: sold, hold, won };
  }

  test("a repeated flash_won for a paid hold does nothing, and a late payment-blocked report never touches a paid moment", async () => {
    const { w, m, hold, won } = await wonSale();
    // Paid (as the x402 route would record it).
    await w.t.run(async (ctx) => {
      await ctx.db.patch(hold._id, { status: "converted" });
      const bookingId = await ctx.db.insert("bookings", {
        workspaceId: w.workspaceId,
        billboardId: w.led,
        slotIds: hold.slotIds,
        amountMinor: hold.amountMinor,
        currency: "USD",
        traceId: hold.traceId,
        holdId: hold._id,
        quoteId: hold.quoteId,
        campaignId: w.launchKit.campaignId,
        status: "confirmed",
      });
      await onMomentPaid(ctx, hold._id, bookingId, { provider: "x402", externalRef: `0x${"cd".repeat(32)}`, amountMinor: hold.amountMinor });
    });
    const fetchesBefore = vi.mocked(fetch).mock.calls.length;
    await w.t.action(internal.companyAgentsNode.act, { advertiserId: w.launchKit.advertiserId, payload: won });
    await w.t.mutation(internal.moments.paymentBlocked, { holdId: hold._id, reason: "late report" });
    const after = await w.momentDoc(m._id);
    expect(after.status).toBe("paid");
    expect(after.paymentBlocked).toBeUndefined();
    expect(after.steps.some((s) => s.key === "payment_blocked")).toBe(false);
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchesBefore); // no probe, no payment
    const row = (await w.t.run(async (ctx) =>
      ctx.db
        .query("companyAgents")
        .withIndex("by_advertiser", (q) => q.eq("advertiserId", w.launchKit.advertiserId))
        .first(),
    ))!;
    expect(row.lastAction).toContain("no longer payable");
  });

  test("the agent never sends its key to a purchase URL off our deployment", async () => {
    const { w, m, won } = await wonSale();
    process.env.CDP_API_KEY_ID = "test-id";
    process.env.CDP_API_KEY_SECRET = "test-secret";
    process.env.CDP_WALLET_SECRET = "test-wallet-secret";
    await w.t.action(internal.companyAgentsNode.act, {
      advertiserId: w.launchKit.advertiserId,
      payload: { ...won, purchaseUrl: "https://elsewhere.test/purchases/x" },
    });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("https://elsewhere.test/"))).toBe(false);
    const after = await w.momentDoc(m._id);
    expect(after.paymentBlocked).toContain("not on this deployment");
    expect(after.status).toBe("failed"); // nobody else joined
  });

  test("setup issues an encrypted key with standing and our webhook, and sets the profile", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorldWithAgents();
    const row = await w.agentRow(w.launchKit);
    expect(row).toMatchObject({ enabled: true, campaignId: w.launchKit.campaignId, walletName: `co-${w.launchKit.advertiserId}` });
    const key = (await w.t.run(async (ctx) => ctx.db.get(row.agentKeyId)))!;
    expect(key.webhookUrl).toBe(`${SITE}/company-agents/${w.launchKit.advertiserId}/webhook`);
    expect(key.webhookUrl!.endsWith(`/company-agents/${w.launchKit.advertiserId}/webhook`)).toBe(true);
    expect(key.standing).toEqual({ maxPricePerSpotMinor: 150, minRelevantViewers: 3, dailyBudgetMinor: 500 });
    expect([...key.scopes].sort()).toEqual(["bid", "hold", "pay", "quote"]);
    expect(key.revokedAt).toBeUndefined();
    const plaintext = await w.agentKey(w.launchKit);
    expect(plaintext.startsWith("bos_agent_")).toBe(true);
    expect(row.keyCiphertext).not.toContain(plaintext);
    expect(row.keyCiphertext).not.toContain("bos_agent");
    const campaign = (await w.t.run(async (ctx) => ctx.db.get(w.launchKit.campaignId)))!;
    expect(campaign.targetAudience).toEqual(AGENT_SETUP.targetAudience);
    // Without CDP keys the wallet can't be created; the agent says so.
    expect(row.lastAction).toContain("no CDP keys");

    // The company sees its agent, never the key.
    const mine = await w.launchKit.customer.query(api.companyAgents.mine, {});
    expect(mine).toMatchObject({
      enabled: true,
      campaignId: w.launchKit.campaignId,
      targetAudience: AGENT_SETUP.targetAudience,
      standing: { maxPricePerSpotMinor: 150, minRelevantViewers: 3, dailyBudgetMinor: 500 },
      walletAddress: null,
      balanceMinor: null,
      spentTodayMinor: 0,
    });
    expect(JSON.stringify(mine)).not.toContain(plaintext);

    // Setting up again revokes the previous key.
    await w.launchKit.customer.mutation(api.companyAgents.setup, { campaignId: w.launchKit.campaignId, ...AGENT_SETUP, maxPerSpotMinor: 120 });
    const again = await w.agentRow(w.launchKit);
    expect(again._id).toBe(row._id);
    expect(again.agentKeyId).not.toBe(row.agentKeyId);
    expect((await w.t.run(async (ctx) => ctx.db.get(row.agentKeyId)))!.revokedAt).toBeDefined();

    // Only the campaign's own company can set it up; bad limits are refused.
    await expect(w.rivet.customer.mutation(api.companyAgents.setup, { campaignId: w.launchKit.campaignId, ...AGENT_SETUP })).rejects.toThrow();
    await expect(w.launchKit.customer.mutation(api.companyAgents.setup, { campaignId: w.launchKit.campaignId, ...AGENT_SETUP, maxPerSpotMinor: 0 })).rejects.toThrow();
    await expect(
      w.launchKit.customer.mutation(api.companyAgents.setup, { campaignId: w.launchKit.campaignId, ...AGENT_SETUP, targetAudience: { "Not A Tag": 1 } }),
    ).rejects.toThrow();
  });

  test("the company webhook rejects a bad signature", async () => {
    const w = await liveWorldWithAgents();
    const res = await w.t.fetch(`/company-agents/${w.launchKit.advertiserId}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BillboardOS-Timestamp": String(Date.now()), "X-BillboardOS-Signature": "0".repeat(64) },
      body: JSON.stringify({ type: "flash_lost" }),
    });
    expect(res.status).toBe(401);
  });

  test("two company agents run a real auction end to end, then payment without CDP keys is blocked, never paid", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorldWithAgents();
    await w.setBalance(w.launchKit, 500);
    await w.setBalance(w.rivet, 500);
    await w.camera(w.led, 10);
    await w.runAll();

    const [m] = await w.momentsOf(w.led);
    const bids = (await w.bidsOf(m._id)).filter((b) => b.kind === "bid");
    expect(bids.length).toBeGreaterThanOrEqual(2);
    for (const c of [w.launchKit, w.rivet]) {
      const mine = bids.filter((b) => b.advertiserId === c.advertiserId);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine.length).toBeLessThanOrEqual(5);
      expect(mine.every((b) => b.amountMinor <= 150)).toBe(true);
    }
    // Each bid beat the one before it.
    for (let i = 1; i < bids.length; i++) expect(bids[i].amountMinor).toBeGreaterThan(bids[i - 1].amountMinor);

    const done = await w.momentDoc(m._id);
    expect(done.paymentBlocked).toBeDefined();
    expect(done.paymentBlocked).toContain("CDP");
    expect(done.steps.some((s) => s.key === "settled")).toBe(false);
    expect(done.paymentTx).toBeUndefined();
    expect(await w.t.run(async (ctx) => ctx.db.query("payments").take(5))).toHaveLength(0);
    // The winner couldn't pay, then the runner-up couldn't either: the moment failed and the host is free.
    expect(done.status).toBe("failed");
    expect((await w.offersOf(m._id)).map((o) => o.status).sort()).toEqual(["defaulted", "defaulted"]);
    expect(await w.t.run(async (ctx) => momentsModule.workspaceBusy(ctx, w.workspaceId))).toBeNull();

    // Each company's feed tells the story without naming the rival.
    const feed = await w.rivet.customer.query(api.companyAgents.feed, {});
    const kinds = new Set(feed.map((e) => e.kind));
    for (const k of ["announce", "bid", "rival_bid", "won", "blocked"] as const) expect(kinds.has(k)).toBe(true);
    expect(kinds.has("paid")).toBe(false);
    expect(feed.filter((e) => e.kind === "rival_bid").every((e) => e.text.includes("Another company"))).toBe(true);
    expect(JSON.stringify(feed)).not.toContain("LaunchKit");
  });

  test("an agent never bids above its wallet balance", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorldWithAgents();
    await w.setBalance(w.launchKit, 50);
    await w.setBalance(w.rivet, 500);
    await w.camera(w.led, 10);
    await w.flush();
    const [m] = await w.momentsOf(w.led);
    expect(m.priceMinor).toBeGreaterThan(50); // the opening price is above LaunchKit's balance
    const lkOffer = (await w.offersOf(m._id)).find((o) => o.advertiserId === w.launchKit.advertiserId)!;
    await w.runAll();
    // It joined with a counter within its balance, and never accepted the opening price.
    const replies = (await w.t.run(async (ctx) => ctx.db.query("auditEvents").take(500))).filter((a) => a.type === "moment.reply" && a.subjectId === lkOffer._id);
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0].reason).toMatch(/^countered \$0\.(\d\d)/);
    expect(Number(/^countered \$0\.(\d\d)/.exec(replies[0].reason)![1])).toBeLessThanOrEqual(50);
    expect(replies.some((a) => /^accepted/.test(a.reason))).toBe(false);
    // No bid, and nothing it was asked to pay, above its balance.
    const lkBids = (await w.bidsOf(m._id)).filter((b) => b.advertiserId === w.launchKit.advertiserId);
    expect(lkBids.every((b) => b.amountMinor <= 50)).toBe(true);
    const lkHolds = await w.t.run(async (ctx) =>
      (await ctx.db.query("holds").take(50)).filter((h) => h.agentKeyId === lkOffer.agentKeyId),
    );
    expect(lkHolds.every((h) => h.amountMinor <= 50)).toBe(true);
  });

  test("in an auction, an agent stops raising at its wallet balance", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorldWithAgents();
    await w.setBalance(w.launchKit, 120);
    await w.setBalance(w.rivet, 500);
    await w.camera(w.led, 10);
    await w.runAll();
    const [m] = await w.momentsOf(w.led);
    expect(m.priceMinor).toBeLessThanOrEqual(120); // both join: a live auction
    const bids = (await w.bidsOf(m._id)).filter((b) => b.kind === "bid");
    const lk = bids.filter((b) => b.advertiserId === w.launchKit.advertiserId);
    const rv = bids.filter((b) => b.advertiserId === w.rivet.advertiserId);
    expect(lk.length).toBeGreaterThanOrEqual(1);
    expect(lk.every((b) => b.amountMinor <= 120)).toBe(true);
    // Rivet, with more money, outbids it at the end.
    expect(Math.max(...rv.map((b) => b.amountMinor))).toBeGreaterThan(Math.max(...lk.map((b) => b.amountMinor)));
  });

  test("a lone company agent negotiates from its last offer, never above its cap", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorldWithAgents();
    await w.setBalance(w.launchKit, 60); // under the opening price: it counters
    await w.setBalance(w.rivet, 0); // can't afford anything: it passes
    await w.camera(w.led, 10);
    await w.flush();
    const [m] = await w.momentsOf(w.led);
    expect((await w.momentDoc(m._id)).steps.some((s) => s.key === "negotiation_started")).toBe(true);
    const lk = (await w.offersOf(m._id)).find((o) => o.advertiserId === w.launchKit.advertiserId)!._id;
    // The counter webhook carries the company's own last offer.
    const counter = await w.t.query(internal.momentDelivery.loadForDelivery, { offerId: lk, event: "negotiation_counter" });
    const lastBuyerOffer = (await w.bidsOf(m._id)).filter((b) => b.kind === "buyer_offer").at(-1)!;
    expect(counter.ok && counter.payload.yourLastOfferMinor).toBe(lastBuyerOffer.amountMinor);
    await w.runAll();
    const offers = (await w.bidsOf(m._id)).filter((b) => b.kind === "buyer_offer");
    expect(offers.length).toBeGreaterThanOrEqual(2); // it answered the host's counter
    expect(offers.every((b) => b.advertiserId === w.launchKit.advertiserId && b.amountMinor <= 60)).toBe(true);
    for (let i = 1; i < offers.length; i++) expect(offers[i].amountMinor).toBeGreaterThan(offers[i - 1].amountMinor);
    const holds = await w.t.run(async (ctx) => ctx.db.query("holds").take(20));
    expect(holds.every((h) => h.amountMinor <= 60)).toBe(true);
  });

  test("turning an agent off mid-auction refuses its later bids", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorldWithAgents();
    await w.setBalance(w.launchKit, 500);
    await w.setBalance(w.rivet, 500);
    const oldKey = await w.agentKey(w.rivet);
    await w.camera(w.led, 10);
    await w.flush();
    vi.advanceTimersByTime(2_000);
    await w.flush();
    const [m] = await w.momentsOf(w.led);
    const live = await w.momentDoc(m._id);
    expect(live.status).toBe("bidding");

    await w.rivet.customer.mutation(api.companyAgents.setEnabled, { enabled: false });
    const rv = (await w.offersOf(m._id)).find((o) => o.advertiserId === w.rivet.advertiserId)!._id;
    const res = await w.t.fetch(`/api/agent/offers/${rv}/bid`, {
      method: "POST",
      headers: { Authorization: `Bearer ${oldKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amountMinor: (live.currentMinor ?? live.priceMinor) + 50 }),
    });
    expect(res.status).toBe(401);
    expect(await w.rivet.customer.query(api.companyAgents.mine, {})).toMatchObject({ enabled: false });

    // Turning it back on issues a fresh key.
    await w.rivet.customer.mutation(api.companyAgents.setEnabled, { enabled: true });
    const fresh = await w.agentKey(w.rivet);
    expect(fresh).not.toBe(oldKey);
    expect((await w.rivet.customer.query(api.companyAgents.mine, {}))!.enabled).toBe(true);
  });

  test("top up is limited to 5 per day", async () => {
    const w = await liveWorldWithAgents();
    for (let i = 0; i < 5; i++) await w.launchKit.customer.mutation(api.companyAgents.requestTopUp, {});
    await expect(w.launchKit.customer.mutation(api.companyAgents.requestTopUp, {})).rejects.toThrow(/RATE_LIMITED|5 top-ups/);
    // Rivet has its own allowance.
    await w.rivet.customer.mutation(api.companyAgents.requestTopUp, {});
  });
});

describe("presenter", () => {
  test("presenter view lists devices, queue and bids", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const phone = await w.addScreen("Phone");
    const { m, lk, rv } = await w.auction();
    await w.camera(phone, 7);
    await w.flush();
    const O = m.priceMinor;
    expect((await w.bid(w.launchKit, lk, O)).status).toBe(200);
    expect((await w.bid(w.rivet, rv, minNextLiveBid({ leaderMinor: O, openingMinor: O }))).status).toBe(200);
    await w.flush();

    const view = await w.host.query(api.moments.live, { billboardId: w.led, atMinute: Date.now() });
    expect(view.devices).toHaveLength(2);
    const led = view.devices.find((d) => d.billboardId === w.led)!;
    expect(led).toMatchObject({ name: "LED", online: true, peopleInView: 10, mode: "auction" });
    const ph = view.devices.find((d) => d.billboardId === phone)!;
    expect(ph).toMatchObject({ name: "Phone", online: true, peopleInView: 7, mode: "your_ad_here" });
    expect(view.queue).toHaveLength(1);
    expect(view.queue[0]).toMatchObject({ billboardId: phone, name: "Phone" });
    const latest = view.latest!;
    expect(latest.bids.length).toBeGreaterThanOrEqual(2);
    expect(latest.bids.map((b) => b.company)).toEqual(expect.arrayContaining(["LaunchKit", "Rivet"]));
    expect(latest.valueMinor).toBeGreaterThan(0);
    expect(latest.priceWhy).toContain("per 1,000 views");
    expect(latest.biddingClosesAt).not.toBeNull();
    expect(latest.extensions).toBe(0);
    await expect(w.launchKit.customer.query(api.moments.live, { billboardId: w.led, atMinute: Date.now() })).rejects.toThrow(/NOT_WORKSPACE_MEMBER/);
  });

  test("the host tops up a company's agent wallet, five a day, workspace members only", async () => {
    const w = await liveWorldWithAgents();
    await w.setBalance(w.launchKit, 150);
    const list = await w.host.query(api.companyAgents.hostList, {});
    expect(list.map((c) => c.company).sort()).toEqual(["LaunchKit", "Rivet"]);
    expect(list.find((c) => c.company === "LaunchKit")).toMatchObject({ advertiserId: w.launchKit.advertiserId, balanceMinor: 150 });

    for (let i = 0; i < 5; i++) await w.host.mutation(api.companyAgents.hostTopUp, { advertiserId: w.launchKit.advertiserId });
    await expect(w.host.mutation(api.companyAgents.hostTopUp, { advertiserId: w.launchKit.advertiserId })).rejects.toThrow(/RATE_LIMITED/);
    // The company's own daily limit is the same counter.
    await expect(w.launchKit.customer.mutation(api.companyAgents.requestTopUp, {})).rejects.toThrow(/RATE_LIMITED/);
    await w.host.mutation(api.companyAgents.hostTopUp, { advertiserId: w.rivet.advertiserId });
    await expect(w.launchKit.customer.mutation(api.companyAgents.hostTopUp, { advertiserId: w.launchKit.advertiserId })).rejects.toThrow(/NO_WORKSPACE/);
    await expect(w.launchKit.customer.query(api.companyAgents.hostList, {})).rejects.toThrow(/NO_WORKSPACE/);
  });
});
