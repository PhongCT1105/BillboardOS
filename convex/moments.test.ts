import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, signedInCustomer, signedInOperator, type TestClient } from "./test.setup";
import { detect, rankReplies, standingCovers, standingDecision } from "./lib/moment";
import { decryptSecret, encryptSecret } from "./lib/demoCrypto";
import { signWebhook } from "./lib/webhook";

// Sunday 2026-10-25, 09:07 PDT: the 09:00 slot has 8 minutes left.
const START = Date.UTC(2026, 9, 25, 16, 7);
const SITE = "https://site.test";
const SECRET = "test-internal-secret-0123456789";

let current: TestClient | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  process.env.INTERNAL_API_SECRET = SECRET;
  process.env.CONVEX_SITE_URL = SITE;
  process.env.DEMO_AGENT_THINK_MS = "0";
  // Agents and webhooks call this deployment's public URL: route those requests into the test deployment.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(SITE) && current) return await current.fetch(url.slice(SITE.length), init);
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.CONVEX_SITE_URL;
  delete process.env.DEMO_AGENT_THINK_MS;
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

async function world() {
  const t = convexTest(schema, modules);
  current = t;
  const host = await signedInOperator(t, "host@moscone.test");
  const seed = await t.action(internal.seed.demoMoment, {});
  await t.finishInProgressScheduledFunctions();
  const billboard = await t.run(async (ctx) => (await ctx.db.query("billboards").withIndex("by_name", (q) => q.eq("name", seed.billboard)).first())!);
  const company = (name: string) => seed.companies.find((c) => c.company === name)!;
  const advertiserOf = async (name: string) =>
    (await t.run(async (ctx) => ctx.db.query("advertisers").withIndex("by_displayName", (q) => q.eq("displayName", name)).first()))!._id;
  return { t, host, seed, billboard, workspaceId: billboard.workspaceId!, company, advertiserOf };
}
type World = Awaited<ReturnType<typeof world>>;

async function moment(w: World, id: Id<"moments">) {
  return (await w.t.run(async (ctx) => ctx.db.get(id)))!;
}
async function offersOf(w: World, id: Id<"moments">) {
  return await w.t.run(async (ctx) => ctx.db.query("flashOffers").withIndex("by_moment", (q) => q.eq("momentId", id)).take(10));
}
/** Run everything scheduled "now", step by step, without jumping the clock (agents reply before the window closes). */
async function flush(w: World, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    vi.advanceTimersByTime(1);
    await w.t.finishInProgressScheduledFunctions();
  }
}
/** Then let time pass (window close, the 60 s pay deadline, ...). */
async function runAll(w: World) {
  await flush(w);
  await w.t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("pure moment logic", () => {
  test("detector: crowd x best segment share, threshold", () => {
    const d = detect({
      crowd: 30,
      crowdSimulated: true,
      screenTags: { software: 0.6, startups: 0.2, tourists: 0.2 },
      event: { name: "Startup Demo Day (seeded)", tags: { startups: 0.7, software: 0.2, press: 0.1 }, uplift: 1.3 },
      threshold: 15,
    });
    expect(d).toMatchObject({ segment: "startups", relevantViewers: 21, fires: true });
    expect(d.reasoning).toMatch(/30 people in the last 15 min \(SIMULATED crowd\); Startup Demo Day \(seeded\) next door \(x1\.3\); 70% startups audience/);
    expect(detect({ crowd: 20, crowdSimulated: false, screenTags: { software: 0.6, tourists: 0.4 }, event: null, threshold: 15 }).fires).toBe(false);
  });

  test("standing instructions and winner ranking", () => {
    const s = { maxPricePerSpotMinor: 3000, minRelevantViewers: 10, dailyBudgetMinor: 5000, policy: "counter" as const, counterRatio: 0.8 };
    expect(standingCovers(s, { floorMinor: 3500, relevantViewers: 20, spentTodayMinor: 0 })).toMatch(/below the seller's floor/);
    expect(standingCovers(s, { floorMinor: 2500, relevantViewers: 5, spentTodayMinor: 0 })).toMatch(/fewer than 10/);
    expect(standingCovers(s, { floorMinor: 2500, relevantViewers: 20, spentTodayMinor: 3000 })).toMatch(/daily budget/);
    expect(standingCovers(s, { floorMinor: 2500, relevantViewers: 20, spentTodayMinor: 0 })).toBeNull();
    expect(standingDecision(s, { priceMinor: 3000, relevantViewers: 20 })).toMatchObject({ decision: "counter", amountMinor: 2400 });
    expect(standingDecision({ ...s, policy: "auto_accept" }, { priceMinor: 3000, relevantViewers: 20 }).decision).toBe("accept");
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

  test("demo agent key encryption round-trip, and a different secret can't read it", async () => {
    const sealed = await encryptSecret(SECRET, "bos_agent_00000000_secret");
    expect(sealed.ciphertext).not.toContain("bos_agent");
    expect(await decryptSecret(SECRET, sealed.ciphertext, sealed.iv)).toBe("bos_agent_00000000_secret");
    await expect(decryptSecret("another-secret-0123456789", sealed.ciphertext, sealed.iv)).rejects.toThrow();
  });
});

describe("live moment", () => {
  test("seed: ready creatives, standing instructions, encrypted keys, rehearsal off and labeled", async () => {
    const w = await world();
    expect(w.seed.companies.map((c) => c.company)).toEqual(["LaunchKit", "Nvidia", "Golden Gate Coffee Co."]);
    expect(w.seed.companies.every((c) => c.label === "simulated customer agent" && c.webhookUrl.startsWith(`${SITE}/demo-agents/`))).toBe(true);
    expect(JSON.stringify(w.seed)).not.toMatch(/bos_agent_[0-9a-f]{8}_/);
    const settings = await w.host.query(api.moments.settings, {});
    expect(settings).toMatchObject({ enabled: true, minRelevantViewers: 15, cooldownMinutes: 10, responseWindowSeconds: 8, rehearsalSettlement: false });
    const ready = await w.host.query(api.creatives.readyForWorkspace, {});
    expect(ready.filter((r) => r.ready).length).toBe(3);
    // Operators (non-owners) can't flip the rehearsal toggle.
    const op = await signedInOperator(w.t, "op@moscone.test");
    expect(await errorCode(op.mutation(api.moments.setRehearsalSettlement, { workspaceId: w.workspaceId, enabled: true }))).toBe("OWNER_ONLY");
    const agents = await w.host.query(api.demoAgents.list, {});
    expect(agents.every((a) => a.label === "simulated customer agent")).toBe(true);
    expect(JSON.stringify(agents)).not.toContain("Ciphertext");
  });

  test("simulated crowd -> offers -> replies -> early close -> winner hold; no payment config -> blocked, default to next, never paid", async () => {
    const w = await world();
    // Golden Gate's agent only pays up to $25 a spot: below this moment's floor.
    const ggId = await w.advertiserOf("Golden Gate Coffee Co.");
    await w.t.run(async (ctx) => {
      const row = (await ctx.db.query("demoAgents").withIndex("by_advertiser", (q) => q.eq("advertiserId", ggId)).first())!;
      const k = (await ctx.db.get(row.agentKeyId))!;
      await ctx.db.patch(k._id, { standing: { ...k.standing!, maxPricePerSpotMinor: 2_500 } });
    });
    const r = await w.host.mutation(api.moments.simulateCrowd, { billboardId: w.billboard._id, people: 30 });
    expect(r.momentId).not.toBeNull();
    const m0 = await moment(w, r.momentId!);
    expect(m0).toMatchObject({ status: "offering", relevantViewers: 21, segment: "startups", trigger: "simulated" });
    expect(m0.reasoning).toMatch(/SIMULATED crowd/);
    expect(m0.spotStartAt).toBeGreaterThanOrEqual(START); // rest of the in-progress slot, or the next one
    const offers0 = await offersOf(w, r.momentId!);
    expect(offers0.length).toBeGreaterThanOrEqual(1);
    expect(offers0.every((o) => o.simulatedAgent)).toBe(true);
    // Golden Gate's standing max is under the floor: not offered.
    const gg = await w.advertiserOf("Golden Gate Coffee Co.");
    expect(offers0.some((o) => o.advertiserId === gg)).toBe(false);
    expect(m0.steps.find((s) => s.key === "targeted")?.detail).toMatch(/skipped Golden Gate Coffee Co\./);

    await runAll(w);
    const m1 = await moment(w, r.momentId!);
    const keys = m1.steps.map((s) => s.key);
    expect(keys).toContain("window_closed");
    expect(m1.steps.find((s) => s.key === "window_closed")?.label).toMatch(/everyone replied/);
    expect(keys).toContain("winner");
    expect(keys).toContain("payment_blocked");
    expect(m1.steps.find((s) => s.key === "payment_blocked")?.label).toMatch(/PAYMENTS_UNAVAILABLE/);
    expect(keys).toContain("defaulted");
    expect(m1.paymentMode).toBeUndefined();
    expect(["failed", "awarded"]).toContain(m1.status);
    // Nothing is ever recorded as paid without settlement.
    expect(await w.t.run(async (ctx) => ctx.db.query("payments").take(5))).toEqual([]);
    const exceptions = await w.t.run(async (ctx) => ctx.db.query("financeExceptions").withIndex("by_status", (q) => q.eq("status", "open")).take(10));
    expect(exceptions.some((e) => e.kind === "winner_default")).toBe(true);
  });

  test("rehearsal settlement (owner toggle): labeled simulated payment, scheduled, first frame stops the stopwatch", async () => {
    const w = await world();
    await w.host.mutation(api.moments.setRehearsalSettlement, { workspaceId: w.workspaceId, enabled: true });
    const r = await w.host.mutation(api.moments.simulateCrowd, { billboardId: w.billboard._id });
    await runAll(w);
    const m = await moment(w, r.momentId!);
    expect(m.status).toBe("paid");
    expect(m.paymentMode).toBe("rehearsal");
    expect(m.paymentTx).toBeUndefined();
    expect(m.steps.find((s) => s.key === "settled")?.label).toBe("REHEARSAL (simulated) payment recorded");
    const payment = (await w.t.run(async (ctx) => ctx.db.query("payments").take(5)))[0];
    expect(payment).toMatchObject({ provider: "manual", externalRef: `rehearsal:${m.holdId}` });
    const slot = (await w.t.run(async (ctx) => ctx.db.get(m.slotId)))!;
    expect(slot.state).toBe("scheduled");
    // LaunchKit auto-accepts at the ask and beats Nvidia's 95% counter.
    const winner = (await w.t.run(async (ctx) => ctx.db.get(m.winnerOfferId!)))!;
    expect(winner.advertiserId).toBe(await w.advertiserOf("LaunchKit"));
    expect(winner.replyAmountMinor).toBe(m.priceMinor);
    // The player sees it and reports the first frame.
    vi.setSystemTime(Math.max(Date.now(), m.spotStartAt + 1_000));
    const now = await w.t.query(api.player.nowPlaying, { billboardId: w.billboard._id, atMinute: Math.floor(Date.now() / 60_000) * 60_000 });
    expect(now.current?.creativeUrl).toBeTruthy();
    await w.t.mutation(api.player.recordPlayback, { slotId: m.slotId, bookingId: m.bookingId!, status: "played" });
    const done = await moment(w, r.momentId!);
    expect(done.status).toBe("playing");
    expect(done.durationMs).toBe(done.firstFrameAt! - done.startedAt);
    // Customer view: "Your agent bought ..."
    const launch = await signedInCustomer(w.t, await w.advertiserOf("LaunchKit"), "founder@launchkit.test");
    const buys = await launch.query(api.moments.myBuys, {});
    expect(buys[0]).toMatchObject({ status: "won", paymentMode: "rehearsal", relevantViewers: expect.any(Number) });
    const other = await signedInCustomer(w.t, await w.advertiserOf("Bay Robotics"), "x@bayrobotics.test");
    expect(await other.query(api.moments.myBuys, {})).toEqual([]);
  });

  test("timeout close, server-side standing enforcement, offer isolation", async () => {
    const w = await world();
    const r = await w.host.mutation(api.moments.simulateCrowd, { billboardId: w.billboard._id });
    const offers = await offersOf(w, r.momentId!);
    const nvidia = await w.advertiserOf("Nvidia");
    const launch = await w.advertiserOf("LaunchKit");
    const nvOffer = offers.find((o) => o.advertiserId === nvidia)!;
    const lkOffer = offers.find((o) => o.advertiserId === launch)!;
    // Use the real keys via the encrypted store, through the HTTP agent API.
    const keyOf = async (advertiserId: Id<"advertisers">) => {
      const row = (await w.t.run(async (ctx) => ctx.db.query("demoAgents").withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId)).first()))!;
      return await decryptSecret(SECRET, row.keyCiphertext, row.keyIv);
    };
    const reply = async (key: string, offerId: string, body: Record<string, unknown>) => {
      const res = await w.t.fetch(`/api/agent/offers/${offerId}/reply`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const nvKey = await keyOf(nvidia);
    // Over the key's standing max -> refused server-side.
    await w.t.run(async (ctx) => {
      const k = (await ctx.db.get(nvOffer.agentKeyId))!;
      await ctx.db.patch(k._id, { standing: { ...k.standing!, maxPricePerSpotMinor: 1_000 } });
    });
    expect(await reply(nvKey, nvOffer._id, { decision: "counter", amountMinor: 1_500 })).toMatchObject({ status: 409, body: { error: { code: "STANDING_INSTRUCTIONS" } } });
    // Someone else's offer -> not found.
    expect((await reply(nvKey, lkOffer._id, { decision: "accept" })).status).toBe(404);
    await w.t.run(async (ctx) => {
      const k = (await ctx.db.get(nvOffer.agentKeyId))!;
      await ctx.db.patch(k._id, { standing: { ...k.standing!, maxPricePerSpotMinor: 9_000 } });
    });
    expect((await reply(nvKey, nvOffer._id, { decision: "counter", amountMinor: nvOffer.priceMinor - 1 })).status).toBe(200);
    expect((await reply(nvKey, nvOffer._id, { decision: "pass" })).body.error.code).toBe("ALREADY_REPLIED");
    // LaunchKit never answers: the window closes on time.
    vi.advanceTimersByTime(8_001);
    await w.t.finishInProgressScheduledFunctions();
    const m = await moment(w, r.momentId!);
    expect(m.steps.find((s) => s.key === "window_closed")?.label).toMatch(/time is up/);
    expect((await w.t.run(async (ctx) => ctx.db.get(lkOffer._id)))!.status).toBe("expired");
    expect((await reply(await keyOf(launch), lkOffer._id, { decision: "accept" })).body.error.code).toBe("OFFER_CLOSED");
    expect((await w.t.run(async (ctx) => ctx.db.get(m.winnerOfferId!)))!.advertiserId).toBe(nvidia);
  });

  test("detector cooldown for automatic triggers; host-only simulation", async () => {
    const w = await world();
    await w.host.mutation(api.moments.setRehearsalSettlement, { workspaceId: w.workspaceId, enabled: true });
    await w.host.mutation(api.moments.simulateCrowd, { billboardId: w.billboard._id });
    await runAll(w);
    // A sensor-driven trigger soon after is held back by the cooldown (the moment is over by now or in cooldown).
    const again = await w.t.mutation(internal.moments.detectFor, { billboardId: w.billboard._id, trigger: "arrivals" });
    expect(again.momentId).toBeNull();
    expect(again.reason).toMatch(/cooling down|already in progress/);
    const customer = await signedInCustomer(w.t, await w.advertiserOf("Nvidia"), "x@nvidia.test");
    expect(await errorCode(customer.mutation(api.moments.simulateCrowd, { billboardId: w.billboard._id }))).toMatch(/NOT_WORKSPACE_MEMBER/);
    // Below threshold: nothing happens.
    await w.host.mutation(api.moments.updateSettings, {
      workspaceId: w.workspaceId,
      enabled: true,
      minRelevantViewers: 500,
      cooldownMinutes: 1,
      responseWindowSeconds: 8,
      minMatch: 0.3,
    });
    vi.advanceTimersByTime(2 * 60 * 60_000);
    expect((await w.host.mutation(api.moments.simulateCrowd, { billboardId: w.billboard._id, people: 30 })).momentId).toBeNull();
  });

  test("demo agent webhook verifies signatures like an external receiver", async () => {
    const w = await world();
    const advertiserId = await w.advertiserOf("LaunchKit");
    const row = (await w.t.run(async (ctx) => ctx.db.query("demoAgents").withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId)).first()))!;
    const key = (await w.t.run(async (ctx) => ctx.db.get(row.agentKeyId)))!;
    const body = JSON.stringify({ type: "flash_lost" });
    const ts = String(Date.now());
    const post = (signature: string, timestamp = ts) =>
      w.t.fetch(`/demo-agents/${advertiserId}/webhook`, {
        method: "POST",
        headers: { "X-BillboardOS-Signature": signature, "X-BillboardOS-Timestamp": timestamp, "Content-Type": "application/json" },
        body,
      });
    expect((await post("sha256=" + "0".repeat(64))).status).toBe(401);
    expect((await post(await signWebhook(key.webhookSecret, String(Date.now() - 10 * 60_000), body), String(Date.now() - 10 * 60_000))).status).toBe(401);
    expect((await post(await signWebhook(key.webhookSecret, ts, body))).status).toBe(200);
  });
});
