import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, signedInCustomer, signedInOperator } from "./test.setup";
import { CONCESSION_SCHEDULE, negotiationFloor, sellerRespond } from "./lib/negotiation";

// Sunday 2026-10-25, 09:07 PDT. Inventory runs 09:15 .. 21:00 local.
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
  const t = convexTest(schema, modules);
  const host = await signedInOperator(t, "host@moscone.test");
  const seed = await host.mutation(internal.seed.demo, {});
  const custA = await signedInCustomer(t, seed.advertiserIds[0], "buyer@goldengate.test");
  const custB = await signedInCustomer(t, seed.advertiserIds[1], "buyer@bayrobotics.test");
  const campaignB = await custB.mutation(api.campaigns.create, { brief: "Robots", budgetMinor: 100_000 });
  const billboard = await t.run(async (ctx) => (await ctx.db.get(seed.billboardId))!);
  const workspaceId = billboard.workspaceId!;
  const slots = await t.query(api.slots.listForBillboard, { billboardId: seed.billboardId, from: START, to: START + 12 * 60 * MIN });
  const keyA = await custA.mutation(api.agentKeys.create, { name: "buyer", scopes: ["quote", "hold", "pay"], budgetCapMinor: 100_000 });
  const keyB = await custB.mutation(api.agentKeys.create, { name: "buyer", scopes: ["quote", "hold"], budgetCapMinor: 100_000 });
  return { t, host, seed, custA, custB, campaignA: seed.campaignId, campaignB, workspaceId, billboard, slots, keyA, keyB };
}
type World = Awaited<ReturnType<typeof world>>;

function open(w: World, overrides: Partial<{ token: string; campaignId: string; slotIds: string[]; amountMinor: number; workspaceId: string }> = {}) {
  return w.t.mutation(internal.negotiations.open, {
    token: overrides.token ?? w.keyA.key,
    workspaceId: overrides.workspaceId ?? w.workspaceId,
    campaignId: overrides.campaignId ?? w.campaignA,
    slotIds: overrides.slotIds ?? [w.slots[8]._id, w.slots[9]._id],
    amountMinor: overrides.amountMinor,
  });
}

function post(w: World, negotiationId: string, kind: "offer" | "accept" | "reject", amountMinor?: number, token?: string) {
  return w.t.mutation(internal.negotiations.post, {
    token: token ?? w.keyA.key,
    workspaceId: w.workspaceId,
    negotiationId,
    kind,
    amountMinor,
  });
}

async function floorOf(w: World, negotiationId: string) {
  return await w.t.run(async (ctx) => (await ctx.db.get(negotiationId as Id<"negotiations">))!);
}

describe("seller policy (pure)", () => {
  test("floor: max(screen x ratio, reserve x slots)", () => {
    expect(negotiationFloor(10_000, 2000, 2, 0.9)).toBe(9000);
    expect(negotiationFloor(4000, 2000, 2, 0.9)).toBe(4000); // reserve floor dominates
  });

  test("never below the floor, counters only go down, concessions shrink", () => {
    for (const floor of [1000, 3600, 9000]) {
      for (const lowball of [1, 500, 2000]) {
        let seller = Math.round(floor * 1.4);
        let best: number | null = null;
        let lastConcession = Infinity;
        for (let round = 1; round <= 4; round++) {
          const offer = lowball * round;
          const d = sellerRespond({ floorMinor: floor, sellerMinor: seller, bestBuyerMinor: best, round, maxRounds: 4 }, offer);
          if (d.kind === "reject") {
            expect(round).toBe(4);
            expect(offer).toBeLessThan(floor);
            break;
          }
          expect(d.amountMinor).toBeGreaterThanOrEqual(floor);
          if (d.kind === "accept") break;
          expect(d.amountMinor).toBeLessThanOrEqual(seller);
          const concession = seller - d.amountMinor;
          expect(concession).toBeLessThanOrEqual(lastConcession + 1); // +1 cent rounding
          lastConcession = concession;
          seller = d.amountMinor;
          best = Math.max(best ?? 0, offer);
        }
      }
    }
    expect([...CONCESSION_SCHEDULE].every((f, i, a) => i === 0 || f <= a[i - 1])).toBe(true);
  });

  test("meets price -> accept at the seller's price; final round accepts at/above floor, rejects below", () => {
    expect(sellerRespond({ floorMinor: 900, sellerMinor: 1200, bestBuyerMinor: null, round: 1, maxRounds: 4 }, 1500)).toMatchObject({
      kind: "accept",
      amountMinor: 1200,
    });
    expect(sellerRespond({ floorMinor: 900, sellerMinor: 1000, bestBuyerMinor: 800, round: 4, maxRounds: 4 }, 950)).toMatchObject({
      kind: "accept",
      amountMinor: 950,
    });
    expect(sellerRespond({ floorMinor: 900, sellerMinor: 1000, bestBuyerMinor: 800, round: 4, maxRounds: 4 }, 899).kind).toBe("reject");
  });
});

describe("negotiations", () => {
  test("ask -> offer -> counter -> accept creates a quote at the agreed amount and a hold for the buyer's key", async () => {
    const w = await world();
    const n0 = await open(w);
    expect(n0.status).toBe("open");
    expect(n0.messages.map((m) => m.kind)).toEqual(["ask"]);
    const stored = await floorOf(w, n0.negotiationId);
    expect(n0.sellerMinor).toBe(stored.askMinor);
    expect(stored.askMinor).toBeGreaterThanOrEqual(stored.floorMinor);
    expect(stored.floorMinor).toBeGreaterThanOrEqual(Math.ceil(stored.screenMinor * 0.9));
    expect(stored.floorMinor).toBeGreaterThanOrEqual(w.billboard.reserveFloorMinor * 2);

    const lowball = Math.round(stored.floorMinor * 0.5);
    const n1 = await post(w, n0.negotiationId, "offer", lowball);
    expect(n1.messages.map((m) => m.kind)).toEqual(["ask", "offer", "counter"]);
    expect(n1.sellerMinor).toBeLessThan(stored.askMinor);
    expect(n1.sellerMinor).toBeGreaterThanOrEqual(stored.floorMinor);
    expect(n1.rounds).toBe(1);

    const n2 = await post(w, n0.negotiationId, "accept");
    expect(n2.status).toBe("agreed");
    expect(n2.agreedMinor).toBe(n1.sellerMinor);
    expect(n2.messages.at(-1)).toMatchObject({ from: "system", kind: "agreement", amountMinor: n1.sellerMinor });
    const check = await w.t.run(async (ctx) => {
      const hold = (await ctx.db.get(n2.holdId!))!;
      const quote = (await ctx.db.get(n2.quoteId!))!;
      const slot = (await ctx.db.get(w.slots[8]._id))!;
      return { hold, quote, slot };
    });
    expect(check.hold).toMatchObject({ amountMinor: n1.sellerMinor, agentKeyId: w.keyA.agentKeyId, status: "active" });
    expect(check.quote.amountMinor).toBe(n1.sellerMinor);
    expect(check.quote.pricingBasis.at(-1)).toMatch(/Negotiated by agents/);
    expect(check.slot.state).toBe("held");
    // Payment route sees the workspace on the hold.
    const forPayment = await w.t.query(internal.holds.getForPayment, { holdId: n2.holdId! });
    expect(forPayment).toMatchObject({ amountMinor: n1.sellerMinor, workspaceId: w.workspaceId, payable: true });
    // Closed negotiations take no more messages.
    expect(await errorCode(post(w, n0.negotiationId, "offer", 100))).toBe("NEGOTIATION_CLOSED");
  });

  test("an opening offer at or above the ask is accepted immediately", async () => {
    const w = await world();
    const probe = await open(w, { slotIds: [w.slots[20]._id] });
    const n = await open(w, { slotIds: [w.slots[21]._id], amountMinor: probe.sellerMinor * 3 });
    expect(n.status).toBe("agreed");
    expect(n.agreedMinor).toBeLessThanOrEqual(n.messages[0].amountMinor!);
  });

  test("max rounds: four lowball offers end in a rejection", async () => {
    const w = await world();
    const n0 = await open(w);
    let n = n0;
    for (let i = 1; i <= 4; i++) n = await post(w, n0.negotiationId, "offer", 100 * i);
    expect(n.status).toBe("rejected");
    expect(n.messages.at(-1)).toMatchObject({ from: "seller", kind: "reject" });
    expect(n.rounds).toBe(4);
    expect(await errorCode(post(w, n0.negotiationId, "offer", 999))).toBe("NEGOTIATION_CLOSED");
  });

  test("expired positions close the negotiation (on reply and by the scheduler)", async () => {
    const w = await world();
    const a = await open(w);
    vi.advanceTimersByTime(2 * MIN + 1);
    const late = await post(w, a.negotiationId, "accept");
    expect(late.status).toBe("expired");
    expect(late.holdId).toBeNull();

    const b = await open(w, { slotIds: [w.slots[30]._id] });
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await floorOf(w, b.negotiationId)).status).toBe("expired");
  });

  test("hot slots refuse negotiation and point to the auction", async () => {
    const w = await world();
    const target = w.slots[12]._id;
    await w.host.mutation(api.auctions.open, { slotIds: [target] });
    expect(await errorCode(open(w, { slotIds: [target] }))).toBe("AUCTION_OPEN");
  });

  test("isolation: other companies, other keys, other hosts", async () => {
    const w = await world();
    const n = await open(w);
    expect(await errorCode(post(w, n.negotiationId, "offer", 100, w.keyB.key))).toBe("NOT_FOUND");
    expect(await errorCode(open(w, { token: w.keyB.key, campaignId: w.campaignA }))).toBe("NOT_COMPANY_MEMBER");
    // A second key of the same company can't hijack the conversation.
    const other = await w.custA.mutation(api.agentKeys.create, { name: "other", scopes: ["quote", "hold"], budgetCapMinor: 1000 });
    expect(await errorCode(post(w, n.negotiationId, "offer", 100, other.key))).toBe("FORBIDDEN");
    // Slots on someone else's host.
    const otherWs = await w.t.run(async (ctx) => ctx.db.insert("workspaces", { name: "Other Host", city: "Oakland" }));
    expect(await errorCode(open(w, { workspaceId: otherWs }))).toBe("NOT_FOUND");
    // Keys without the hold scope can't negotiate.
    const quoteOnly = await w.custA.mutation(api.agentKeys.create, { name: "q", scopes: ["quote"], budgetCapMinor: 1000 });
    expect(await errorCode(open(w, { token: quoteOnly.key }))).toBe("SCOPE_MISSING");
    // Timelines are scoped.
    expect(await w.custB.query(api.negotiations.mine, {})).toEqual([]);
    expect((await w.custA.query(api.negotiations.mine, {})).length).toBe(1);
    expect((await w.host.query(api.negotiations.forWorkspace, {}))[0].negotiation.negotiationId).toBe(n.negotiationId);
  });

  test("budget cap: an agreement over the key's cap is refused and nothing is held", async () => {
    const w = await world();
    const small = await w.custA.mutation(api.agentKeys.create, { name: "tiny", scopes: ["quote", "hold"], budgetCapMinor: 500 });
    const n = await open(w, { token: small.key });
    expect(await errorCode(post(w, n.negotiationId, "accept", undefined, small.key))).toBe("BUDGET_CAP");
    const after = await floorOf(w, n.negotiationId);
    expect(after.status).toBe("open");
    expect(after.holdId).toBeUndefined();
  });

  test("slots sold during the conversation: the agreement fails cleanly", async () => {
    const w = await world();
    const n = await open(w, { slotIds: [w.slots[40]._id] });
    const quote = await w.custB.mutation(api.quotes.create, { campaignId: w.campaignB, slotIds: [w.slots[40]._id] });
    await w.custB.mutation(api.holds.create, { quoteId: quote.quoteId, idempotencyKey: "steal", actor: "web" });
    const after = await post(w, n.negotiationId, "accept");
    expect(after.status).toBe("failed");
    expect(after.holdId).toBeNull();
    expect(after.messages.at(-1)?.kind).toBe("failed");
  });

  test("HTTP: /internal/a2a needs the internal secret and maps errors", async () => {
    const w = await world();
    const call = (path: string, body: unknown, secret = SECRET) =>
      w.t.fetch(`/internal/a2a/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await call("negotiations", {}, "wrong")).status).toBe(401);
    const res = await call("negotiations", { agentKey: w.keyA.key, workspaceId: w.workspaceId, campaignId: w.campaignA, slotIds: [w.slots[8]._id] });
    expect(res.status).toBe(201);
    const n = (await res.json()) as { negotiationId: string };
    const bad = await call("negotiations/messages", { agentKey: w.keyB.key, workspaceId: w.workspaceId, negotiationId: n.negotiationId, kind: "offer", amountMinor: 1 });
    expect(bad.status).toBe(404);
    const card = await w.t.fetch(`/internal/a2a/agent-card?workspaceId=${w.workspaceId}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    const cardBody = (await card.json()) as { name: string; negotiation: { maxRounds: number }; screens: unknown[] };
    expect(cardBody).toMatchObject({ name: "Moscone Media", negotiation: { maxRounds: 4 } });
    expect(JSON.stringify(cardBody)).not.toContain("floorRatio");
  });
});

describe("policy and data sales", () => {
  test("owners set the policy; it changes floor and rounds", async () => {
    const w = await world();
    const operator = await signedInOperator(w.t, "op2@moscone.test");
    expect(
      await errorCode(operator.mutation(api.a2a.setNegotiationPolicy, { workspaceId: w.workspaceId, floorRatio: 0.8, maxRounds: 2, offerTtlSeconds: 60 })),
    ).toBe("OWNER_ONLY");
    expect(
      await errorCode(w.host.mutation(api.a2a.setNegotiationPolicy, { workspaceId: w.workspaceId, floorRatio: 0.2, maxRounds: 2, offerTtlSeconds: 60 })),
    ).toBe("INVALID_INPUT");
    await w.host.mutation(api.a2a.setNegotiationPolicy, { workspaceId: w.workspaceId, floorRatio: 1, maxRounds: 2, offerTtlSeconds: 60 });
    expect(await w.host.query(api.a2a.negotiationPolicy, {})).toEqual({ floorRatio: 1, maxRounds: 2, offerTtlSeconds: 60, isDefault: false });
    const n = await open(w);
    const stored = await floorOf(w, n.negotiationId);
    expect(stored.maxRounds).toBe(2);
    expect(stored.floorMinor).toBeGreaterThanOrEqual(stored.screenMinor);
    expect(n.offerExpiresAt - START).toBeLessThanOrEqual(60_000 + 1000);
  });

  test("audience report and data-sale recording (idempotent on tx hash, scoped views)", async () => {
    const w = await world();
    const auth = await w.t.mutation(internal.a2a.authorizeReport, {
      token: w.keyA.key,
      workspaceId: w.workspaceId,
      billboardId: w.seed.billboardId,
    });
    expect(auth.advertiserId).toBe(w.seed.advertiserIds[0]);
    const report = await w.t.query(internal.a2a.audienceReport, { workspaceId: w.workspaceId, billboardId: w.seed.billboardId });
    expect(report.billboard.name).toBe(w.billboard.name);
    expect(report.crowd.windowMinutes).toBe(120);
    expect(report.notes[0]).toMatch(/Aggregate counts only/);
    const sale = {
      token: w.keyA.key,
      workspaceId: w.workspaceId,
      billboardId: w.seed.billboardId,
      amountMinor: 5,
      txHash: "0x" + "ab".repeat(32),
      network: "eip155:84532",
    };
    const first = await w.t.mutation(internal.a2a.recordDataSale, sale);
    const again = await w.t.mutation(internal.a2a.recordDataSale, sale);
    expect(again).toEqual({ dataSaleId: first.dataSaleId, replayed: true });
    const finance = await w.host.query(api.a2a.dataSalesForWorkspace, {});
    expect(finance).toMatchObject({ totalMinor: 5, count: 1 });
    expect(finance.recent[0]).toMatchObject({ companyName: "Golden Gate Coffee Co.", amountMinor: 5 });
    expect(await w.custA.query(api.a2a.dataPurchasesMine, {})).toHaveLength(1);
    expect(await w.custB.query(api.a2a.dataPurchasesMine, {})).toEqual([]);
    // Another host's screen can't be sold under this workspace.
    const otherWs = await w.t.run(async (ctx) => ctx.db.insert("workspaces", { name: "Other Host", city: "Oakland" }));
    expect(
      await errorCode(w.t.mutation(internal.a2a.authorizeReport, { token: w.keyA.key, workspaceId: otherWs, billboardId: w.seed.billboardId })),
    ).toBe("NOT_FOUND");
  });
});


