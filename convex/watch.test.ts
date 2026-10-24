import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules, signedInCustomer, signedInOperator, type TestClient } from "./test.setup";
import { ruleFitsSlot, summarizeRule, triggersFor } from "./lib/watch";

// Sunday 2026-10-25, 09:07 PDT (UTC-7). Inventory runs 09:15 .. 21:00 local.
const START = Date.UTC(2026, 9, 25, 16, 7);
const MIN = 60_000;
const BIG = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

/** Independent verifier: what a receiver does with the timestamp, raw body and its secret. */
async function verifySignature(secret: string, timestamp: string, rawBody: string, header: string): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const bytes = new Uint8Array(m[1].match(/../g)!.map((h) => parseInt(h, 16)));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return await crypto.subtle.verify("HMAC", key, bytes, enc.encode(`${timestamp}.${rawBody}`));
}

async function world() {
  const t = convexTest(schema, modules);
  const host = await signedInOperator(t, "host@moscone.test");
  const seed = await host.mutation(internal.seed.demo, {});
  const custA = await signedInCustomer(t, seed.advertiserIds[0], "buyer@goldengate.test");
  const custB = await signedInCustomer(t, seed.advertiserIds[1], "buyer@bayrobotics.test");
  const campaignB = await custB.mutation(api.campaigns.create, { brief: "Robots", budgetMinor: 100_000 });
  return { t, host, seed, custA, custB, campaignA: seed.campaignId, campaignB, billboardId: seed.billboardId };
}

type World = Awaited<ReturnType<typeof world>>;

function rule(w: World, overrides: Record<string, unknown> = {}) {
  return {
    campaignId: w.campaignA,
    name: "Morning SF",
    maxPriceMinor: BIG,
    triggers: ["available" as const],
    delivery: ["inbox" as const],
    ...overrides,
  };
}

/** Run the matcher over the demo screen right now (what the sweep does per screen). */
async function sweepScreen(w: World) {
  return await w.t.mutation(internal.watch.match, { billboardIds: [w.billboardId], reason: "test" });
}

/** Run functions scheduled "now" (runAfter(0)) without jumping the clock. */
async function flush(w: World) {
  vi.advanceTimersByTime(1);
  await w.t.finishInProgressScheduledFunctions();
}

async function inbox(c: TestClient) {
  return await c.query(api.alerts.inbox, {});
}

function localHour(ts: number) {
  const d = new Date(ts - 7 * 60 * MIN);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

describe("pure matcher", () => {
  const screen = { billboardId: "b1", city: "San Francisco", utcOffsetMinutes: -420, matchScore: 0.7 };
  const base = { maxPriceMinor: 6000, triggers: ["available" as const] };
  const at = (h: number) => Date.UTC(2026, 9, 25, h + 7, 0); // h:00 PDT on Sunday

  test("where/when filters", () => {
    expect(ruleFitsSlot(base, screen, at(9))).toBe(true);
    expect(ruleFitsSlot({ ...base, cities: ["san francisco "] }, screen, at(9))).toBe(true);
    expect(ruleFitsSlot({ ...base, cities: ["Oakland"] }, screen, at(9))).toBe(false);
    expect(ruleFitsSlot({ ...base, billboardIds: ["b2"] }, screen, at(9))).toBe(false);
    expect(ruleFitsSlot({ ...base, minMatch: 0.6 }, screen, at(9))).toBe(true);
    expect(ruleFitsSlot({ ...base, minMatch: 0.8 }, screen, at(9))).toBe(false);
    expect(ruleFitsSlot({ ...base, minMatch: 0.1 }, { ...screen, matchScore: null }, at(9))).toBe(false);
    expect(ruleFitsSlot({ ...base, hourStart: 8, hourEnd: 11 }, screen, at(8))).toBe(true);
    expect(ruleFitsSlot({ ...base, hourStart: 8, hourEnd: 11 }, screen, at(11))).toBe(false);
    expect(ruleFitsSlot({ ...base, daysOfWeek: [0] }, screen, at(9))).toBe(true); // Sunday local
    expect(ruleFitsSlot({ ...base, daysOfWeek: [1, 2, 3, 4, 5] }, screen, at(9))).toBe(false);
    expect(ruleFitsSlot({ ...base, dateFrom: at(10) }, screen, at(9))).toBe(false);
    expect(ruleFitsSlot({ ...base, dateTo: at(8) }, screen, at(9))).toBe(false);
  });

  test("each trigger", () => {
    const all = { ...base, triggers: ["available", "price_drop", "last_minute", "auction_open"] as ("available" | "price_drop" | "last_minute" | "auction_open")[] };
    const slot = { startAt: at(12), available: true, auctionOpen: false, priceMinor: 5000, previousPriceMinor: null, lastMinuteDiscount: false };
    const now = at(9);
    expect(triggersFor(all, slot, now)).toEqual(["available"]);
    expect(triggersFor(all, { ...slot, previousPriceMinor: 7000 }, now)).toEqual(["available", "price_drop"]);
    expect(triggersFor(all, { ...slot, priceMinor: 7000 }, now)).toEqual([]);
    const soon = { ...slot, startAt: now + 30 * MIN, lastMinuteDiscount: true };
    expect(triggersFor({ ...base, triggers: ["last_minute"] }, soon, now)).toEqual(["last_minute"]);
    expect(triggersFor({ ...base, triggers: ["last_minute"] }, { ...soon, startAt: now + 90 * MIN }, now)).toEqual([]);
    expect(triggersFor(all, { ...slot, auctionOpen: true }, now)).toEqual(["auction_open"]);
  });

  test("plain-language summary", () => {
    expect(
      summarizeRule({ maxPriceMinor: 6000, minMatch: 0.6, cities: ["SF"], hourStart: 8, hourEnd: 11, triggers: ["available"] }),
    ).toBe("Tell me when a slot on a screen matching 60%+ of my audience in SF is under $60.00 between 8 AM and 11 AM");
  });
});

describe("watch rules", () => {
  test("available: one grouped alert, deduped, inbox live with unread count", async () => {
    const w = await world();
    const { ruleId, summary } = await w.custA.mutation(api.watchRules.create, rule(w, { hourStart: 10, hourEnd: 12 }));
    expect(summary).toContain("between 10 AM and 12 PM");

    const first = await sweepScreen(w);
    expect(first.alertsCreated).toBe(1);
    const box = await inbox(w.custA);
    expect(box.unreadCount).toBe(1);
    const [alert] = box.alerts;
    expect(alert).toMatchObject({ ruleId, trigger: "available", matchCount: 8, read: false, agent: null });
    expect(alert.slots).toHaveLength(5);
    for (const s of alert.slots) {
      expect(localHour(s.startAt)).toBeGreaterThanOrEqual(10);
      expect(localHour(s.startAt)).toBeLessThan(12);
    }
    expect(alert.priceMinor).toBe(Math.min(...alert.slots.map((s) => s.screenPriceMinor)));

    // Dedupe on (rule, slot, trigger): nothing new on the next pass.
    expect((await sweepScreen(w)).alertsCreated).toBe(0);

    // Isolation: the other company sees nothing and can't touch it.
    expect((await inbox(w.custB)).alerts).toEqual([]);
    expect(await w.custB.query(api.watchRules.list, {})).toEqual([]);
    expect(await errorCode(w.custB.mutation(api.alerts.markRead, { alertId: alert.alertId }))).toBe("NOT_COMPANY_MEMBER");
    expect(await errorCode(w.custB.mutation(api.watchRules.pause, { ruleId }))).toBe("NOT_COMPANY_MEMBER");
    expect(await errorCode(w.custB.mutation(api.watchRules.create, rule(w)))).toBe("NOT_COMPANY_MEMBER");

    await w.custA.mutation(api.alerts.markRead, { alertId: alert.alertId });
    expect((await inbox(w.custA)).unreadCount).toBe(0);
  });

  test("filters: price, cities, days, match, screens", async () => {
    const w = await world();
    const make = (name: string, o: Record<string, unknown>) => w.custA.mutation(api.watchRules.create, rule(w, { name, ...o }));
    const cheap = await make("too cheap", { maxPriceMinor: 1 });
    const oakland = await make("oakland", { cities: ["Oakland"] });
    const weekdays = await make("weekdays", { daysOfWeek: [1, 2, 3, 4, 5] });
    const match = await make("match", { minMatch: 0.9 }); // campaign has no target audience
    const sf = await make("sf sunday", { cities: ["san francisco"], daysOfWeek: [0], billboardIds: [w.billboardId] });
    await sweepScreen(w);
    const byRule = new Map<string, number>();
    for (const a of (await inbox(w.custA)).alerts) byRule.set(a.ruleId, (byRule.get(a.ruleId) ?? 0) + 1);
    for (const r of [cheap, oakland, weekdays, match]) expect(byRule.get(r.ruleId)).toBeUndefined();
    expect(byRule.get(sf.ruleId)).toBe(1);

    // Validation
    expect(await errorCode(make("x", { hourStart: 11, hourEnd: 8 }))).toBe("INVALID_INPUT");
    expect(await errorCode(make("x", { maxPriceMinor: Number.NaN }))).toBe("INVALID_INPUT");
    expect(await errorCode(make("x", { daysOfWeek: [7] }))).toBe("INVALID_INPUT");
    expect(await errorCode(make("x", { triggers: [] }))).toBe("INVALID_INPUT");
    expect(await errorCode(make("x", { delivery: ["agent"] }))).toBe("INVALID_INPUT");
  });

  test("paused rules never alert; resuming does", async () => {
    const w = await world();
    const { ruleId } = await w.custA.mutation(api.watchRules.create, rule(w));
    await w.custA.mutation(api.watchRules.pause, { ruleId });
    expect((await sweepScreen(w)).alertsCreated).toBe(0);
    await flush(w);
    expect((await inbox(w.custA)).alerts).toEqual([]);
    expect((await w.custA.query(api.watchRules.list, {}))[0].active).toBe(false);
    await w.custA.mutation(api.watchRules.pause, { ruleId, paused: false });
    expect((await sweepScreen(w)).alertsCreated).toBe(1);
  });

  test("price_drop fires once when the price falls under the max", async () => {
    const w = await world();
    await w.custA.mutation(api.watchRules.create, rule(w, { maxPriceMinor: 2500, triggers: ["price_drop"], hourStart: 12, hourEnd: 13 }));
    expect((await sweepScreen(w)).alertsCreated).toBe(0); // ~$40 now: remembered, not alerted
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.billboardId, { baseRateMinor: 1000, reserveFloorMinor: 500 });
    });
    expect((await sweepScreen(w)).alertsCreated).toBe(1);
    const [alert] = (await inbox(w.custA)).alerts;
    expect(alert.trigger).toBe("price_drop");
    expect(alert.reason).toMatch(/Price dropped .* \(was \$/);
    expect(alert.priceMinor).toBeLessThanOrEqual(2500);
    expect((await sweepScreen(w)).alertsCreated).toBe(0);
  });

  test("last_minute fires for discounted slots inside the hour", async () => {
    const w = await world();
    await w.custA.mutation(api.watchRules.create, rule(w, { triggers: ["last_minute"] }));
    await sweepScreen(w);
    const [alert] = (await inbox(w.custA)).alerts;
    expect(alert.trigger).toBe("last_minute");
    for (const s of alert.slots) expect(s.startAt - START).toBeLessThan(60 * MIN);
    expect((await sweepScreen(w)).alertsCreated).toBe(0);
  });

  test("auction_open fires from the auction-opened hook with the auction id", async () => {
    const w = await world();
    await w.custA.mutation(api.watchRules.create, rule(w, { triggers: ["auction_open"] }));
    await flush(w);
    const slots = await w.t.query(api.slots.listForBillboard, { billboardId: w.billboardId, from: START, to: START + 12 * 60 * MIN });
    const target = slots[12];
    const { auctionId } = await w.host.mutation(api.auctions.open, { slotIds: [target._id] });
    await flush(w);
    const alerts = (await inbox(w.custA)).alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ trigger: "auction_open", auctionId, slots: [expect.objectContaining({ slotId: target._id })] });
  });

  test("a released hold puts slots back in front of watchers", async () => {
    const w = await world();
    await w.custA.mutation(api.watchRules.create, rule(w, { hourStart: 14, hourEnd: 15 }));
    await flush(w);
    expect((await inbox(w.custA)).alerts).toHaveLength(1);
    const slots = await w.t.query(api.slots.listForBillboard, { billboardId: w.billboardId, from: START, to: START + 12 * 60 * MIN });
    const two = slots.filter((s) => localHour(s.startAt) >= 14 && localHour(s.startAt) < 14.5).map((s) => s._id);
    const quote = await w.custB.mutation(api.quotes.create, { campaignId: w.campaignB, slotIds: two });
    const hold = await w.custB.mutation(api.holds.create, { quoteId: quote.quoteId, idempotencyKey: "watch-hold-1", actor: "web" });
    await w.custB.mutation(api.holds.release, { holdId: hold.holdId, idempotencyKey: "watch-hold-1" });
    await flush(w);
    const alerts = (await inbox(w.custA)).alerts;
    expect(alerts).toHaveLength(2);
    expect(alerts[0].slots.map((s) => s.slotId).sort()).toEqual([...two].sort());
  });
});

describe("agent delivery", () => {
  async function agentRule(w: World, webhookUrl = "https://agent.example/hook") {
    const key = await w.custA.mutation(api.agentKeys.create, {
      name: "watcher",
      scopes: ["quote", "hold"],
      budgetCapMinor: 50_000,
      webhookUrl,
    });
    await w.custA.mutation(api.watchRules.create, rule(w, { hourStart: 10, hourEnd: 11, delivery: ["inbox", "agent"], agentKeyId: key.agentKeyId }));
    return key;
  }

  test("signed POST is verifiable with the key's secret and recorded as delivered", async () => {
    const w = await world();
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("ok", { status: 200 });
      }),
    );
    const key = await agentRule(w);
    await flush(w); // first run of the rule -> alert -> delivery scheduled
    await flush(w); // delivery

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://agent.example/hook");
    const headers = calls[0].init.headers as Record<string, string>;
    const raw = calls[0].init.body as string;
    const ts = headers["X-BillboardOS-Timestamp"];
    const sig = headers["X-BillboardOS-Signature"];
    expect(Number(ts)).toBeGreaterThan(0);
    expect(await verifySignature(key.webhookSecret, ts, raw, sig)).toBe(true);
    expect(await verifySignature("whsec_wrong", ts, raw, sig)).toBe(false);
    expect(await verifySignature(key.webhookSecret, ts, raw + " ", sig)).toBe(false);
    // Replay with a fresh timestamp fails: the signature is bound to the original one.
    expect(await verifySignature(key.webhookSecret, String(Number(ts) + 60_000), raw, sig)).toBe(false);
    // Body-only HMAC (the old format) is not accepted.
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey("raw", enc.encode(key.webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const bodyOnly = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(sig).not.toBe(`sha256=${bodyOnly}`);
    const payload = JSON.parse(raw);
    expect(payload).toMatchObject({
      trigger: "available",
      campaignId: w.campaignA,
      billboard: { name: expect.any(String) },
      links: { quote: "/api/agent/quotes", ack: `/api/agent/alerts/${payload.alertId}/ack` },
    });
    expect(payload.slots[0]).toEqual(expect.objectContaining({ slotId: expect.any(String), screenPriceMinor: expect.any(Number) }));
    expect(raw).not.toContain(key.webhookSecret);
    expect(raw).not.toContain(key.key);

    const [alert] = (await inbox(w.custA)).alerts;
    expect(alert.agent).toEqual({ status: "delivered", attempts: 1, lastError: null });
  });

  test("retries with backoff, then records the failure", async () => {
    const w = await world();
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await agentRule(w);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [alert] = (await inbox(w.custA)).alerts;
    expect(alert.agent).toEqual({ status: "failed", attempts: 3, lastError: "HTTP 500" });
  });

  test("a later attempt can succeed", async () => {
    const w = await world();
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n < 3) throw new Error("connection refused");
        return new Response("ok");
      }),
    );
    await agentRule(w);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    const [alert] = (await inbox(w.custA)).alerts;
    expect(alert.agent).toEqual({ status: "delivered", attempts: 3, lastError: null });
  });

  test("a revoked key stops delivery", async () => {
    const w = await world();
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const key = await agentRule(w);
    await w.custA.mutation(api.agentKeys.revoke, { agentKeyId: key.agentKeyId });
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).not.toHaveBeenCalled();
    const [alert] = (await inbox(w.custA)).alerts;
    expect(alert.agent?.status).toBe("failed");
  });

  test("agent rules need the company's own key with a webhook", async () => {
    const w = await world();
    const noHook = await w.custA.mutation(api.agentKeys.create, { name: "nohook", scopes: ["quote"], budgetCapMinor: 100 });
    const other = await w.custB.mutation(api.agentKeys.create, {
      name: "theirs",
      scopes: ["quote"],
      budgetCapMinor: 100,
      webhookUrl: "https://b.example/hook",
    });
    expect(await errorCode(w.custA.mutation(api.watchRules.create, rule(w, { delivery: ["agent"], agentKeyId: noHook.agentKeyId })))).toBe(
      "INVALID_INPUT",
    );
    expect(await errorCode(w.custA.mutation(api.watchRules.create, rule(w, { delivery: ["agent"], agentKeyId: other.agentKeyId })))).toBe(
      "NOT_COMPANY_MEMBER",
    );
  });

  test("GET /api/agent/alerts and ack, scoped to the key's company", async () => {
    const w = await world();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const keyA = await agentRule(w);
    const keyB = await w.custB.mutation(api.agentKeys.create, { name: "b", scopes: ["quote"], budgetCapMinor: 100 });
    await flush(w);
    const get = async (key: string, qs = "") => {
      const res = await w.t.fetch(`/api/agent/alerts${qs}`, { headers: { Authorization: `Bearer ${key}` } });
      return { status: res.status, body: (await res.json()) as { alerts: { alertId: string; createdAt: number }[] } };
    };
    const a = await get(keyA.key);
    expect(a.status).toBe(200);
    expect(a.body.alerts).toHaveLength(1);
    const alertId = a.body.alerts[0].alertId;
    expect((await get(keyA.key, `?since=${a.body.alerts[0].createdAt}`)).body.alerts).toHaveLength(0);
    expect((await get(keyB.key)).body.alerts).toHaveLength(0);
    expect((await get(keyA.key, "?since=abc")).status).toBe(400);

    const ack = (key: string, id: string) =>
      w.t.fetch(`/api/agent/alerts/${id}/ack`, { method: "POST", headers: { Authorization: `Bearer ${key}` } });
    expect((await ack(keyB.key, alertId)).status).toBe(404);
    expect((await ack(keyA.key, "not-an-id")).status).toBe(404);
    expect((await ack(keyA.key, alertId)).status).toBe(200);
    expect((await ack(keyA.key, alertId)).status).toBe(200); // idempotent
    expect((await get(keyA.key)).body.alerts).toHaveLength(0);
  });
});

describe("demo seed", () => {
  test("demoWatchRules creates one rule per demo company and is re-runnable", async () => {
    const w = await world();
    await w.t.mutation(internal.seed.pricingDemo, {});
    const first = await w.t.mutation(internal.seed.demoWatchRules, {});
    expect(first.rules.map((r) => r.company)).toEqual(["Golden Gate Coffee Co.", "Nvidia"]);
    // No public webhook URL: Nvidia's rule is inbox-only and no key is issued.
    expect(first.webhook).toBeNull();
    expect((await w.t.mutation(internal.seed.demoWatchRules, { webhookUrl: "http://localhost:8787/alerts" })).webhook).toBeNull();
    expect((await w.t.mutation(internal.seed.demoWatchRules, { webhookUrl: "https://localhost:8787/alerts" })).webhook).toBeNull();
    const second = await w.t.mutation(internal.seed.demoWatchRules, { webhookUrl: "https://example.trycloudflare.com/alerts" });
    expect(second.replacedRules).toBe(2);
    expect(second.webhook).toMatchObject({ url: "https://example.trycloudflare.com/alerts", envVar: "WEBHOOK_SECRET" });
    expect(second.webhook?.webhookSecret).toMatch(/^whsec_/);
    expect(await w.custA.query(api.watchRules.list, {})).toHaveLength(1);
  });
});

describe("customer portal", () => {
  test("bookings and invoices are scoped to the caller's company", async () => {
    const w = await world();
    const slots = await w.t.query(api.slots.listForBillboard, { billboardId: w.billboardId, from: START, to: START + 12 * 60 * MIN });
    const quote = await w.custA.mutation(api.quotes.create, { campaignId: w.campaignA, slotIds: [slots[20]._id] });
    const hold = await w.custA.mutation(api.holds.create, { quoteId: quote.quoteId, idempotencyKey: "portal-1", actor: "web" });
    await w.t.run(async (ctx) => {
      const invoiceId = await ctx.db.insert("invoices", {
        number: "INV-9001",
        advertiserId: w.seed.advertiserIds[0],
        campaignId: w.campaignA,
        description: "Moscone slot",
        amountMinor: quote.amountMinor,
        currency: "USD",
        issuedAt: START,
        dueAt: START + 15 * 24 * 60 * MIN,
        status: "partially_paid",
        paidMinor: 1000,
        adjustmentMinor: 0,
        writtenOffMinor: 0,
        source: "booking",
      });
      await ctx.db.insert("bookings", {
        holdId: hold.holdId,
        quoteId: quote.quoteId,
        campaignId: w.campaignA,
        billboardId: w.billboardId,
        slotIds: [slots[20]._id],
        amountMinor: quote.amountMinor,
        currency: "USD",
        invoiceId,
        status: "confirmed",
        traceId: "t",
      });
    });
    const mine = await w.custA.query(api.customerPortal.bookings, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ paidBy: "invoice", invoiceNumber: "INV-9001", slotCount: 1, firstStartAt: slots[20].startAt });
    const invoices = await w.custA.query(api.customerPortal.invoices, {});
    expect(invoices[0]).toMatchObject({ number: "INV-9001", balanceMinor: quote.amountMinor - 1000 });
    expect(await w.custB.query(api.customerPortal.bookings, {})).toEqual([]);
    expect(await w.custB.query(api.customerPortal.invoices, {})).toEqual([]);
    expect(await errorCode(w.custB.query(api.customerPortal.bookings, { advertiserId: w.seed.advertiserIds[0] }))).toBe("NOT_COMPANY_MEMBER");
  });
});

describe("stopping deliveries", () => {
  test("stopPending marks pending agent deliveries failed and no retry runs", async () => {
    const w = await world();
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const key = await w.custA.mutation(api.agentKeys.create, {
      name: "watcher",
      scopes: ["quote"],
      budgetCapMinor: 100,
      webhookUrl: "http://localhost:8787/alerts",
    });
    await w.custA.mutation(api.watchRules.create, rule(w, { hourStart: 10, hourEnd: 11, delivery: ["agent"], agentKeyId: key.agentKeyId }));
    await flush(w); // first run -> alert
    await flush(w); // attempt 1 fails -> retry scheduled
    expect((await inbox(w.custA)).alerts[0].agent).toMatchObject({ status: "pending", attempts: 1 });
    expect(await w.t.mutation(internal.watchDelivery.stopPending, { reason: "localhost webhook" })).toEqual({ scanned: 1, stopped: 1 });
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await inbox(w.custA)).alerts[0].agent).toMatchObject({ status: "failed", lastError: "Stopped: localhost webhook" });
  });
});
