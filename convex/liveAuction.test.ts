import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as momentsModule from "./moments";
import { modules, signedInCustomer, signedInOperator, type TestClient } from "./test.setup";
import { ensureUpcomingSlots } from "./lib/inventory";
import { BIDDING_MS, EXTENSION_MS, MAX_EXTENSIONS, NEXT_SPOT_LEAD_MS, REOFFER_DELAY_MS, minNextLiveBid } from "./lib/liveAuction";
import { onMomentPaid, releaseWorkspace } from "./lib/momentHooks";
import { rankReplies, standingCovers } from "./lib/moment";
import { decryptSecret, encryptSecret } from "./lib/demoCrypto";

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

  test("simulateCrowd is gone", async () => {
    expect((momentsModule as Record<string, unknown>).simulateCrowd).toBeUndefined();
    const w = await liveWorld();
    // `api` is a proxy that names any function, so check the deployment has none by that name.
    const ref = (api.moments as unknown as Record<string, typeof api.moments.setRehearsalSettlement>).simulateCrowd;
    await expect(w.host.mutation(ref, { billboardId: w.led } as never)).rejects.toThrow();
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
    await w.flush();
    expect((await w.momentDoc(m._id)).status).toBe("no_takers");
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

  test("an auction nobody bids in ends with no takers and a re-offer", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m } = await w.auction();
    await w.advance(m.biddingClosesAt! - Date.now() + 1);
    expect((await w.momentDoc(m._id)).status).toBe("no_takers");
    expect((await w.pendingDetects()).some((s) => s.args[0].trigger === "reoffer")).toBe(true);
  });

  test("webhooks: offer carries the price story; auction events reach every participant", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const w = await liveWorld();
    const { m, lk } = await w.auction();
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
    const fetchMock = vi.mocked(fetch);
    await w.flush();
    const events = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith("https://agent.test/"))
      .map(([, init]) => (init?.headers as Record<string, string>)["X-BillboardOS-Event"]);
    expect(events.filter((e) => e === "auction_started")).toHaveLength(2);
    expect(events.filter((e) => e === "auction_update")).toHaveLength(2);
  });
});
