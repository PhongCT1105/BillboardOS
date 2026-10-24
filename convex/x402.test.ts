import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules, signedInCustomer, signedInOperator } from "./test.setup";
import { paidRoutes } from "./lib/x402/flow";

// Fake CDP facilitator: the real x402 resource server, routes and Bazaar
// extension, with verify/settle stubbed so tests never touch the network.
const fake = vi.hoisted(() => ({
  verifyCalls: 0,
  settleCalls: 0,
  settleOk: true,
  tx: "0x" + "ab".repeat(32),
  onVerify: null as null | (() => Promise<void>),
}));

const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const NETWORK = "eip155:84532" as const;

vi.mock("./lib/x402/cdpEngine", () => {
  const facilitator: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: ["bazaar"], signers: {} };
    },
    async verify(payload) {
      fake.verifyCalls++;
      if (fake.onVerify) await fake.onVerify();
      return { isValid: true, payer: (payload.payload as { authorization?: { from?: string } }).authorization?.from };
    },
    async settle(_payload, requirements) {
      fake.settleCalls++;
      return fake.settleOk
        ? { success: true, transaction: fake.tx, network: requirements.network, payer: "0xBuyer000000000000000000000000000000000001" }
        : { success: false, errorReason: "insufficient_funds", transaction: "", network: requirements.network };
    },
  };
  let engine: Promise<{ engine: x402HTTPResourceServer; defaultPayTo: string; network: typeof NETWORK }> | null = null;
  return {
    x402Config: () => ({ network: NETWORK, environment: "development" }),
    getEngine: () => {
      engine ??= (async () => {
        const rs = new x402ResourceServer(facilitator);
        rs.register(NETWORK, new ExactEvmScheme());
        rs.registerExtension(bazaarResourceServerExtension);
        const server = new x402HTTPResourceServer(rs, paidRoutes(NETWORK));
        await server.initialize();
        return { engine: server, defaultPayTo: PAY_TO, network: NETWORK };
      })();
      return engine;
    },
  };
});

// Sunday 2026-10-25, 09:07 PDT.
const START = Date.UTC(2026, 9, 25, 16, 7);
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  Object.assign(fake, { verifyCalls: 0, settleCalls: 0, settleOk: true, onVerify: null, tx: "0x" + "ab".repeat(32) });
});
afterEach(() => {
  vi.useRealTimers();
});

async function world() {
  const t = convexTest(schema, modules);
  const host = await signedInOperator(t, "host@moscone.test");
  const seed = await host.mutation(internal.seed.demo, {});
  const custA = await signedInCustomer(t, seed.advertiserIds[0], "buyer@goldengate.test");
  const custB = await signedInCustomer(t, seed.advertiserIds[1], "buyer@bayrobotics.test");
  const billboard = await t.run(async (ctx) => (await ctx.db.get(seed.billboardId))!);
  const workspaceId = billboard.workspaceId!;
  const slots = await t.query(api.slots.listForBillboard, { billboardId: seed.billboardId, from: START, to: START + 12 * 60 * MIN });
  const keyA = await custA.mutation(api.agentKeys.create, { name: "payer", scopes: ["quote", "hold", "pay"], budgetCapMinor: 100_000 });
  const keyB = await custB.mutation(api.agentKeys.create, { name: "other", scopes: ["quote", "hold", "pay"], budgetCapMinor: 100_000 });
  const quote = await custA.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[10]._id] });
  const hold = await custA.mutation(api.holds.create, { quoteId: quote.quoteId, idempotencyKey: "x402-hold", actor: "web" });
  return { t, host, seed, custA, custB, workspaceId, billboard, keyA, keyB, hold };
}
type World = Awaited<ReturnType<typeof world>>;

type Decoded = { x402Version: number; accepts: Record<string, unknown>[]; resource: Record<string, unknown>; extensions?: Record<string, unknown> };
const decode = (header: string | null): Decoded => JSON.parse(atob(header!));
const encode = (value: unknown) => btoa(JSON.stringify(value));

/** A signed-looking payment for the first accepted requirement of a 402 (the fake facilitator accepts it). */
function paymentFor(challenge: Decoded) {
  return encode({
    x402Version: challenge.x402Version,
    resource: challenge.resource,
    accepted: challenge.accepts[0],
    payload: { authorization: { from: "0xBuyer000000000000000000000000000000000001" }, signature: "0x00" },
  });
}

async function call(w: World, method: "GET" | "POST", path: string, key: string | null, payment?: string) {
  const res = await w.t.fetch(path, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(payment ? { "PAYMENT-SIGNATURE": payment } : {}) },
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
}

describe("x402 on Convex: challenges", () => {
  test("audience report: 402 with requirements, payTo and Bazaar metadata; key and host checks", async () => {
    const w = await world();
    const path = `/a2a/hosts/${w.workspaceId}/reports/audience?billboardId=${w.seed.billboardId}`;
    expect((await call(w, "GET", path, null)).status).toBe(401);
    const r = await call(w, "GET", path, w.keyA.key);
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ product: "audience_report", amountMinor: 5, price: "$0.05", network: NETWORK });
    const challenge = decode(r.headers.get("PAYMENT-REQUIRED"));
    expect(challenge.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, amount: "50000", payTo: PAY_TO });
    expect(challenge.extensions?.bazaar).toBeDefined();
    expect(String(challenge.resource.url)).toContain("/reports/audience");
    const other = await w.t.run(async (ctx) => ctx.db.insert("workspaces", { name: "Other Host", city: "Oakland" }));
    expect((await call(w, "GET", `/a2a/hosts/${other}/reports/audience?billboardId=${w.seed.billboardId}`, w.keyA.key)).status).toBe(404);
    expect(fake.verifyCalls).toBe(0);
  });

  test("purchase: 402 for the hold amount on both routes; wrong host 404; wrong company 403; no key 401", async () => {
    const w = await world();
    for (const path of [`/purchases/${w.hold.holdId}`, `/a2a/hosts/${w.workspaceId}/purchases/${w.hold.holdId}`]) {
      const r = await call(w, "POST", path, w.keyA.key);
      expect(r.status).toBe(402);
      expect(r.body).toMatchObject({ holdId: w.hold.holdId, amountMinor: w.hold.amountMinor });
      const c = decode(r.headers.get("PAYMENT-REQUIRED"));
      expect(c.accepts[0]).toMatchObject({ amount: String(w.hold.amountMinor * 10_000), payTo: PAY_TO, network: NETWORK });
    }
    // A workspace payout address wins over the default.
    await w.t.run(async (ctx) => ctx.db.patch(w.workspaceId, { payoutAddress: "0x1111111111111111111111111111111111111111" }));
    const c = decode((await call(w, "POST", `/purchases/${w.hold.holdId}`, w.keyA.key)).headers.get("PAYMENT-REQUIRED"));
    expect(c.accepts[0].payTo).toBe("0x1111111111111111111111111111111111111111");

    const other = await w.t.run(async (ctx) => ctx.db.insert("workspaces", { name: "Other Host", city: "Oakland" }));
    expect((await call(w, "POST", `/a2a/hosts/${other}/purchases/${w.hold.holdId}`, w.keyA.key)).body).toMatchObject({ error: "HOLD_NOT_FOUND" });
    expect((await call(w, "POST", `/purchases/${w.hold.holdId}`, null)).status).toBe(401);
    expect(await call(w, "POST", `/purchases/${w.hold.holdId}`, w.keyB.key)).toMatchObject({ status: 403, body: { error: "NOT_COMPANY_MEMBER" } });
    const quoteOnly = await w.custA.mutation(api.agentKeys.create, { name: "q", scopes: ["quote"], budgetCapMinor: 100 });
    expect(await call(w, "POST", `/purchases/${w.hold.holdId}`, quoteOnly.key)).toMatchObject({ status: 403, body: { error: "SCOPE_MISSING" } });
    expect((await call(w, "POST", `/purchases/nope`, w.keyA.key)).status).toBe(404);
  });
});

describe("x402 on Convex: verify -> re-check -> settle -> record", () => {
  test("paid hold is booked, PAYMENT-RESPONSE is set, and a second attempt finds nothing to pay", async () => {
    const w = await world();
    const path = `/a2a/hosts/${w.workspaceId}/purchases/${w.hold.holdId}`;
    const challenge = decode((await call(w, "POST", path, w.keyA.key)).headers.get("PAYMENT-REQUIRED"));
    const paid = await call(w, "POST", path, w.keyA.key, paymentFor(challenge));
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ outcome: "booked", holdId: w.hold.holdId, payment: { transaction: fake.tx, amountMinor: w.hold.amountMinor } });
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(fake.settleCalls).toBe(1);
    const payments = await w.t.run(async (ctx) => ctx.db.query("payments").take(10));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ externalRef: fake.tx, amountMinor: w.hold.amountMinor, provider: "x402" });
    const again = await call(w, "POST", path, w.keyA.key, paymentFor(challenge));
    expect(again).toMatchObject({ status: 409, body: { error: "HOLD_NOT_PAYABLE" } });
    expect(fake.settleCalls).toBe(1);
  });

  test("hold lapses between verify and settle: cancelled, nothing settled or recorded", async () => {
    const w = await world();
    const path = `/purchases/${w.hold.holdId}`;
    const challenge = decode((await call(w, "POST", path, w.keyA.key)).headers.get("PAYMENT-REQUIRED"));
    fake.onVerify = async () => {
      await w.t.run(async (ctx) => ctx.db.patch(w.hold.holdId, { status: "expired" }));
    };
    const r = await call(w, "POST", path, w.keyA.key, paymentFor(challenge));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "HOLD_NOT_PAYABLE" });
    expect(String(r.body.message)).toMatch(/NOT settled; no funds moved/);
    expect(fake.verifyCalls).toBe(1);
    expect(fake.settleCalls).toBe(0);
    expect(await w.t.run(async (ctx) => ctx.db.query("payments").take(10))).toEqual([]);
  });

  test("settlement failure records nothing and leaves the hold payable", async () => {
    const w = await world();
    fake.settleOk = false;
    const path = `/purchases/${w.hold.holdId}`;
    const challenge = decode((await call(w, "POST", path, w.keyA.key)).headers.get("PAYMENT-REQUIRED"));
    const r = await call(w, "POST", path, w.keyA.key, paymentFor(challenge));
    expect(r.status).not.toBe(200);
    expect(fake.settleCalls).toBe(1);
    expect(await w.t.run(async (ctx) => ctx.db.query("payments").take(10))).toEqual([]);
    expect((await w.t.query(internal.holds.getForPayment, { holdId: w.hold.holdId }))?.payable).toBe(true);
  });

  test("paid report: delivered and recorded once per settlement tx", async () => {
    const w = await world();
    const path = `/a2a/hosts/${w.workspaceId}/reports/audience?billboardId=${w.seed.billboardId}`;
    const challenge = decode((await call(w, "GET", path, w.keyA.key)).headers.get("PAYMENT-REQUIRED"));
    const paid = await call(w, "GET", path, w.keyA.key, paymentFor(challenge));
    expect(paid.status).toBe(200);
    expect(paid.body.report.billboard.name).toBe(w.billboard.name);
    expect(paid.body.payment).toMatchObject({ transaction: fake.tx, amountMinor: 5 });
    const replay = await call(w, "GET", path, w.keyA.key, paymentFor(challenge)); // same tx hash from the facilitator
    expect(replay.body.dataSaleId).toBe(paid.body.dataSaleId);
    const sales = await w.host.query(api.a2a.dataSalesForWorkspace, {});
    expect(sales).toMatchObject({ count: 1, totalMinor: 5 });
  });
});

describe("seller agent routes on Convex", () => {
  test("agent card and negotiations", async () => {
    const w = await world();
    const card = await call(w, "GET", `/a2a/hosts/${w.workspaceId}/agent.json`, null);
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ schema: "billboardos.agent-card/v1", host: { name: "Moscone Media" }, negotiation: { maxRounds: 4 } });
    expect(JSON.stringify(card.body)).not.toContain("floorRatio");
    const slots = await w.t.query(api.slots.listForBillboard, { billboardId: w.seed.billboardId, from: START, to: START + 12 * 60 * MIN });
    const res = await w.t.fetch(`/a2a/hosts/${w.workspaceId}/negotiations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${w.keyA.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId: w.seed.campaignId, slotIds: [slots[20]._id] }),
    });
    expect(res.status).toBe(201);
    const n = (await res.json()) as { negotiationId: string };
    const got = await call(w, "GET", `/a2a/hosts/${w.workspaceId}/negotiations/${n.negotiationId}`, w.keyA.key);
    expect(got.body.status).toBe("open");
    expect((await call(w, "GET", `/a2a/hosts/${w.workspaceId}/negotiations/${n.negotiationId}`, w.keyB.key)).status).toBe(404);
  });
});
