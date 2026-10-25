import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { holdFor, modules, quoteFor, signedInCustomer, signedInOperator, type TestClient } from "./test.setup";
import { RATE_LIMIT_PER_MINUTE } from "./lib/agentKeys";

// 09:07 PDT. slots[8] airs 11:15 local: screen price $40.00.
const START = Date.UTC(2026, 9, 25, 16, 7);
const MIN = 60_000;
const SECRET = "test-internal-secret";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  process.env.INTERNAL_API_SECRET = SECRET;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.INTERNAL_API_SECRET;
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
  const anon = convexTest(schema, modules);
  const host = await signedInOperator(anon, "host@moscone.test");
  const seed = await host.mutation(internal.seed.demo, {});
  const custA = await signedInCustomer(anon, seed.advertiserIds[0], "buyer@goldengate.test");
  const custB = await signedInCustomer(anon, seed.advertiserIds[1], "buyer@bayrobotics.test");
  const campaignA = seed.campaignId;
  const campaignB = await custB.mutation(api.campaigns.create, { brief: "Robots", budgetMinor: 100_000 });
  const slots = await anon.query(api.slots.listForBillboard, {
    billboardId: seed.billboardId,
    from: START,
    to: START + 24 * 60 * MIN,
  });
  return { anon, host, seed, custA, custB, campaignA, campaignB, slots };
}

async function issue(cust: TestClient, overrides: Partial<{ scopes: ("quote" | "hold" | "bid" | "pay")[]; budgetCapMinor: number; campaignIds: Id<"campaigns">[]; name: string }> = {}) {
  return await cust.mutation(api.agentKeys.create, {
    name: overrides.name ?? "buyer-bot",
    scopes: overrides.scopes ?? ["quote", "hold", "bid", "pay"],
    budgetCapMinor: overrides.budgetCapMinor ?? 100_000,
    campaignIds: overrides.campaignIds,
  });
}

/** Call the agent HTTP API like an external agent would. */
async function call(t: TestClient, key: string | null, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await t.fetch(`/api/agent/${path}`, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("agent key management", () => {
  test("issued once, listed without secrets, revocable only by its company, validated", async () => {
    const w = await world();
    const k = await issue(w.custA, { budgetCapMinor: 5000 });
    expect(k.key).toMatch(/^bos_agent_[0-9a-f]{8}_[0-9a-f]{48}$/);
    expect(k.prefix).toBe(k.key.slice(0, 18));
    expect(k.webhookSecret).toMatch(/^whsec_/);

    const listed = await w.custA.query(api.agentKeys.list, {});
    expect(listed).toHaveLength(1);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(k.key);
    expect(text).not.toContain(k.webhookSecret);
    expect(listed[0]).toMatchObject({ name: "buyer-bot", prefix: k.prefix, status: "active", committedMinor: 0, budgetCapMinor: 5000 });
    expect(await w.custB.query(api.agentKeys.list, {})).toEqual([]);

    expect(await errorCode(w.custB.mutation(api.agentKeys.revoke, { agentKeyId: k.agentKeyId }))).toBe("NOT_COMPANY_MEMBER");
    await w.custA.mutation(api.agentKeys.revoke, { agentKeyId: k.agentKeyId });
    expect((await w.custA.query(api.agentKeys.list, {}))[0].status).toBe("revoked");

    for (const bad of [
      { webhookUrl: "http://example.com/hook" },
      { scopes: [] as never[] },
      { budgetCapMinor: 0 },
      { campaignIds: [w.campaignB] },
    ]) {
      expect(
        await errorCode(
          w.custA.mutation(api.agentKeys.create, { name: "x", scopes: ["quote"], budgetCapMinor: 100, ...bad }),
        ),
      ).toMatch(/INVALID_INPUT|NOT_COMPANY_MEMBER/);
    }
    await expect(
      w.custA.mutation(api.agentKeys.create, { name: "dev", scopes: ["quote"], budgetCapMinor: 100, webhookUrl: "http://localhost:8787/hook" }),
    ).resolves.toBeDefined();
    expect(await errorCode(w.anon.mutation(api.agentKeys.create, { name: "x", scopes: ["quote"], budgetCapMinor: 100 }))).toBe(
      "UNAUTHENTICATED",
    );
  });
});

describe("agent HTTP API", () => {
  test("missing, unknown, revoked and expired keys are refused", async () => {
    const w = await world();
    const k = await issue(w.custA);
    expect(await call(w.anon, null, "GET", "me")).toMatchObject({ status: 401, body: { error: { code: "INVALID_KEY" } } });
    expect(await call(w.anon, "bos_agent_00000000_" + "0".repeat(48), "GET", "me")).toMatchObject({
      status: 401,
      body: { error: { code: "INVALID_KEY" } },
    });
    expect((await call(w.anon, k.key, "GET", "me")).status).toBe(200);
    vi.setSystemTime(k.expiresAt + 1);
    expect(await call(w.anon, k.key, "GET", "me")).toMatchObject({ status: 401, body: { error: { code: "KEY_EXPIRED" } } });
    vi.setSystemTime(START);
    await w.custA.mutation(api.agentKeys.revoke, { agentKeyId: k.agentKeyId });
    expect(await call(w.anon, k.key, "GET", "me")).toMatchObject({ status: 401, body: { error: { code: "KEY_REVOKED" } } });
  });

  test("me as the company's agent: its key, its campaigns, last used", async () => {
    const w = await world();
    const k = await issue(w.custA);
    const me = await call(w.anon, k.key, "GET", "me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      company: { displayName: "Golden Gate Coffee Co." },
      key: { name: "buyer-bot", scopes: ["quote", "hold", "bid", "pay"], committedMinor: 0 },
    });
    expect(me.body.campaigns.map((c: { campaignId: string }) => c.campaignId)).toEqual([w.campaignA]);
    const listed = (await w.custA.query(api.agentKeys.list, {}))[0];
    expect(Math.abs((listed.lastUsedAt ?? 0) - Date.now())).toBeLessThan(1000);
    expect((await call(w.anon, k.key, "GET", "nothing-here")).status).toBe(404);
  });

  test("answering a round needs the bid scope; a key lists only its allowed campaigns", async () => {
    const w = await world();
    const quoteOnly = await issue(w.custA, { scopes: ["quote"], name: "quoter" });
    expect(await call(w.anon, quoteOnly.key, "POST", "rounds/nope/bid", { amountMinor: 100 })).toMatchObject({
      status: 403,
      body: { error: { code: "SCOPE_MISSING" } },
    });
    const bidder = await issue(w.custA, { name: "bidder" });
    expect((await call(w.anon, bidder.key, "POST", "rounds/nope/bid", { amountMinor: 100 })).status).toBe(404);
    await w.custA.mutation(api.campaigns.create, { brief: "Second", budgetMinor: 50_000 });
    const scoped = await issue(w.custA, { campaignIds: [w.campaignA], name: "scoped" });
    expect((await call(w.anon, scoped.key, "GET", "me")).body.campaigns.map((c: { campaignId: string }) => c.campaignId)).toEqual([
      w.campaignA,
    ]);
  });

  test("rate limit per key", async () => {
    const w = await world();
    const k = await issue(w.custA);
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) expect((await call(w.anon, k.key, "GET", "me")).status).toBe(200);
    expect(await call(w.anon, k.key, "GET", "me")).toMatchObject({ status: 429, body: { error: { code: "RATE_LIMITED" } } });
    vi.advanceTimersByTime(61_000);
    expect((await call(w.anon, k.key, "GET", "me")).status).toBe(200);
  });
});

describe("x402 pay check", () => {
  async function verify(t: TestClient, body: unknown, auth = `Bearer ${SECRET}`) {
    const res = await t.fetch("/internal/agent-keys/verify-payment", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  test("only a key with the pay scope from the hold's company may pay; payout goes to the hold's workspace", async () => {
    const w = await world();
    const payer = await issue(w.custA, { name: "payer" });
    const noPay = await issue(w.custA, { scopes: ["quote", "hold"], name: "no-pay" });
    const other = await issue(w.custB, { name: "other" });
    const h = await holdFor(w.anon, await quoteFor(w.anon, { campaignId: w.campaignA, slotIds: [w.slots[8]._id] }), "pay-1");
    const holdId = h.holdId as string;

    expect((await verify(w.anon, { agentKey: payer.key, holdId }, "Bearer wrong")).status).toBe(401);
    expect(await verify(w.anon, { agentKey: payer.key, holdId })).toMatchObject({
      status: 200,
      body: { holdId, actor: "agent:Golden Gate Coffee Co./payer" },
    });
    expect((await verify(w.anon, { agentKey: noPay.key, holdId })).body.error.code).toBe("SCOPE_MISSING");
    expect((await verify(w.anon, { agentKey: other.key, holdId })).body.error.code).toBe("NOT_COMPANY_MEMBER");
    expect((await verify(w.anon, { agentKey: payer.key, holdId: "nope" })).status).toBe(404);

    const workspaceId = (await w.anon.run(async (ctx) => (await ctx.db.get(w.seed.billboardId))!.workspaceId))!;
    await w.host.mutation(api.workspaces.setPayoutAddress, { workspaceId, payoutAddress: "0x2222222222222222222222222222222222222222" });
    const res = await w.anon.fetch(`/internal/holds?holdId=${holdId}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    expect((await res.json()).payTo).toBe("0x2222222222222222222222222222222222222222");
  });
});
