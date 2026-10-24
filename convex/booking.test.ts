import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, signedInOperator, type TestClient, joinCompanies } from "./test.setup";
import { HOLD_TTL_MS, QUOTE_TTL_MS } from "./lib/constants";

// 09:07 PDT; first seeded slot starts 09:15 PDT (hour factor 1.0, base $40).
const START = Date.UTC(2026, 9, 25, 16, 7);
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

async function setup() {
  const t = await signedInOperator(convexTest(schema, modules));
  const seed = await t.mutation(internal.seed.demo, {});
  await joinCompanies(t);
  const slots = await t.query(api.slots.listForBillboard, {
    billboardId: seed.billboardId,
    from: START,
    to: START + 24 * 60 * 60 * 1000,
  });
  return { t, seed, slots };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code: string }).code;
    throw error;
  }
  throw new Error("expected promise to reject");
}

function allRows<T extends "slots" | "holds" | "bookings" | "payments" | "financeExceptions" | "quotes">(
  t: TestClient,
  table: T,
) {
  return t.run(async (ctx) => await ctx.db.query(table).collect());
}

describe("seed", () => {
  test("is idempotent", async () => {
    const { t, seed, slots } = await setup();
    expect(slots).toHaveLength(48);
    expect(slots[0].startAt).toBe(Date.UTC(2026, 9, 25, 16, 15));
    expect(slots.every((s) => s.state === "available")).toBe(true);
    const again = await t.mutation(internal.seed.demo, {});
    await joinCompanies(t);
    expect(again.created).toBe(false);
    expect(again.billboardId).toBe(seed.billboardId);
    expect(await allRows(t, "slots")).toHaveLength(48);
  });
});

describe("quotes", () => {
  test("baseline quote without audience; audience raises price", async () => {
    const { t, seed, slots } = await setup();
    const baseline = await t.mutation(api.quotes.create, {
      campaignId: seed.campaignId,
      slotIds: [slots[4]._id],
    });
    // slots[4] airs 10:15 local, more than an hour out: no last-minute discount.
    expect(baseline.amountMinor).toBe(4000);
    expect(baseline.confidence).toBe("low");
    expect(baseline.expiresAt - START).toBeGreaterThanOrEqual(QUOTE_TTL_MS);
    expect(baseline.expiresAt - START).toBeLessThan(QUOTE_TTL_MS + 1000);

    await t.mutation(api.audience.record, {
      billboardId: seed.billboardId,
      countEstimate: 180,
      source: "camera",
      confidence: 1,
    });
    // Pricing uses a trailing 15-min window; at 16:07 only 7/15 of it is measured
    // (confidence capped). Two minutes later more than half is covered.
    vi.setSystemTime(START + 2 * 60 * 1000);
    const busy = await t.mutation(api.quotes.create, {
      campaignId: seed.campaignId,
      slotIds: [slots[4]._id],
    });
    expect(busy.amountMinor).toBe(6000);
    expect(busy.confidence).toBe("high");
  });

  test("rejects duplicate and unavailable slots", async () => {
    const { t, seed, slots } = await setup();
    expect(
      await errorCode(
        t.mutation(api.quotes.create, {
          campaignId: seed.campaignId,
          slotIds: [slots[0]._id, slots[0]._id],
        }),
      ),
    ).toBe("INVALID_INPUT");
    const q = await t.mutation(api.quotes.create, {
      campaignId: seed.campaignId,
      slotIds: [slots[0]._id],
    });
    await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "k1", actor: "buyer:a" });
    expect(
      await errorCode(
        t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[0]._id] }),
      ),
    ).toBe("SLOT_UNAVAILABLE");
  });
});

describe("holds", () => {
  test("two holds racing for the same slot -> exactly one succeeds", async () => {
    const { t, seed, slots } = await setup();
    const qa = await t.mutation(api.quotes.create, {
      campaignId: seed.campaignId,
      slotIds: [slots[0]._id],
    });
    const qb = await t.mutation(api.quotes.create, {
      campaignId: seed.campaignId,
      slotIds: [slots[0]._id, slots[1]._id],
    });

    const results = await Promise.allSettled([
      t.mutation(api.holds.create, { quoteId: qa.quoteId, idempotencyKey: "buyer-a", actor: "buyer:a" }),
      t.mutation(api.holds.create, { quoteId: qb.quoteId, idempotencyKey: "buyer-b", actor: "buyer:b" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const reason = (failed[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ConvexError);
    expect(reason.data.code).toBe("SLOT_UNAVAILABLE");

    const winner = (ok[0] as PromiseFulfilledResult<{ holdId: Id<"holds"> }>).value;
    const holds = await allRows(t, "holds");
    expect(holds).toHaveLength(1);
    const slot0 = await t.run(async (ctx) => await ctx.db.get(slots[0]._id));
    expect(slot0?.state).toBe("held");
    expect(slot0?.holdId).toBe(winner.holdId);
    // The loser's second slot must not be left held by a partial write.
    const slot1 = await t.run(async (ctx) => await ctx.db.get(slots[1]._id));
    if (holds[0].slotIds.length === 1) {
      expect(slot1?.state).toBe("available");
    }
  });

  test("same idempotencyKey returns the existing hold", async () => {
    const { t, seed, slots } = await setup();
    const q = await t.mutation(api.quotes.create, {
      campaignId: seed.campaignId,
      slotIds: [slots[0]._id, slots[1]._id],
    });
    const first = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "same", actor: "buyer" });
    const second = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "same", actor: "buyer" });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.holdId).toBe(first.holdId);
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(first.expiresAt - START).toBeGreaterThanOrEqual(HOLD_TTL_MS);
    expect(await allRows(t, "holds")).toHaveLength(1);

    const other = await t.mutation(api.quotes.create, {
      campaignId: seed.campaignId,
      slotIds: [slots[5]._id],
    });
    expect(
      await errorCode(
        t.mutation(api.holds.create, { quoteId: other.quoteId, idempotencyKey: "same", actor: "buyer" }),
      ),
    ).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  test("hold expiry releases slots", async () => {
    const { t, seed, slots } = await setup();
    const q = await t.mutation(api.quotes.create, {
      campaignId: seed.campaignId,
      slotIds: [slots[3]._id, slots[4]._id],
    });
    const hold = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "h", actor: "buyer" });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const after = await t.run(async (ctx) => ({
      hold: await ctx.db.get(hold.holdId),
      quote: await ctx.db.get(q.quoteId),
      s0: await ctx.db.get(slots[3]._id),
      s1: await ctx.db.get(slots[4]._id),
    }));
    expect(after.hold?.status).toBe("expired");
    expect(after.quote?.status).toBe("expired");
    for (const s of [after.s0, after.s1]) {
      expect(s?.state).toBe("available");
      expect(s?.holdId).toBeUndefined();
    }
    const trail = await t.query(api.audit.forTrace, { traceId: q.traceId });
    expect(trail.map((e) => e.type)).toEqual(
      expect.arrayContaining(["quote.created", "slot.held", "hold.expired", "slot.released", "quote.expired"]),
    );

    // Slots are sellable again; re-running the old expiry is a no-op.
    const q2 = await t.mutation(api.quotes.create, {
      campaignId: seed.campaignId,
      slotIds: [slots[3]._id],
    });
    const hold2 = await t.mutation(api.holds.create, { quoteId: q2.quoteId, idempotencyKey: "h2", actor: "buyer" });
    await t.mutation(internal.holds.expire, { holdId: hold.holdId });
    const s0 = await t.run(async (ctx) => await ctx.db.get(slots[3]._id));
    expect(s0?.state).toBe("held");
    expect(s0?.holdId).toBe(hold2.holdId);
  });

  test("release requires the holder's key and frees slots", async () => {
    const { t, seed, slots } = await setup();
    const q = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[0]._id] });
    const hold = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "mine", actor: "buyer" });
    expect(
      await errorCode(
        t.mutation(api.holds.release, { holdId: hold.holdId, idempotencyKey: "not-mine", actor: "x" }),
      ),
    ).toBe("FORBIDDEN");
    const released = await t.mutation(api.holds.release, {
      holdId: hold.holdId,
      idempotencyKey: "mine",
      actor: "buyer",
    });
    expect(released.status).toBe("released");
    const s0 = await t.run(async (ctx) => await ctx.db.get(slots[0]._id));
    expect(s0?.state).toBe("available");
  });
});

describe("payments", () => {
  async function held() {
    const ctx = await setup();
    const q = await ctx.t.mutation(api.quotes.create, {
      campaignId: ctx.seed.campaignId,
      slotIds: [ctx.slots[4]._id, ctx.slots[5]._id],
    });
    const hold = await ctx.t.mutation(api.holds.create, {
      quoteId: q.quoteId,
      idempotencyKey: "hold-1",
      actor: "buyer",
    });
    return { ...ctx, q, hold };
  }

  const pay = (holdId: string, overrides: Partial<{ externalRef: string; amountMinor: number; asset: string }> = {}) => ({
    holdId,
    provider: "x402" as const,
    externalRef: "0xabc",
    amountMinor: 8000,
    asset: "USDC",
    network: "base-sepolia",
    idempotencyKey: "pay-1",
    ...overrides,
  });

  test("verified payment books the held slots", async () => {
    const { t, seed, q, hold, slots } = await held();
    expect(hold.amountMinor).toBe(8000);
    const result = await t.mutation(internal.payments.recordVerified, pay(hold.holdId));
    expect(result.outcome).toBe("booked");
    if (result.outcome !== "booked") throw new Error("unreachable");
    expect(result.replayed).toBe(false);

    const state = await t.run(async (ctx) => ({
      hold: await ctx.db.get(hold.holdId),
      quote: await ctx.db.get(q.quoteId),
      booking: await ctx.db.get(result.bookingId),
      payment: await ctx.db.get(result.paymentId),
      s0: await ctx.db.get(slots[4]._id),
      s1: await ctx.db.get(slots[5]._id),
    }));
    expect(state.hold?.status).toBe("converted");
    expect(state.quote?.status).toBe("accepted");
    expect(state.booking?.status).toBe("confirmed");
    expect(state.booking?.amountMinor).toBe(8000);
    expect(state.payment?.status).toBe("verified");
    for (const s of [state.s0, state.s1]) {
      expect(s?.state).toBe("booked");
      expect(s?.bookingId).toBe(result.bookingId);
    }

    // Later scheduled expiries are no-ops on a converted hold.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const s0 = await t.run(async (ctx) => await ctx.db.get(slots[4]._id));
    expect(s0?.state).toBe("booked");

    const summary = await t.query(api.dashboard.summary, {});
    const row = summary.billboards.find((b) => b.billboardId === seed.billboardId)!;
    expect(row.confirmedRevenueMinor).toBe(8000);
    expect(row.slotCounts.booked).toBe(2);
    expect(row.slotCounts.available).toBe(46);
    expect(row.openExceptions).toBe(0);
  });

  test("replayed externalRef returns the original outcome, never a second booking", async () => {
    const { t, hold } = await held();
    const first = await t.mutation(internal.payments.recordVerified, pay(hold.holdId));
    const replay = await t.mutation(internal.payments.recordVerified, pay(hold.holdId, { amountMinor: 1 }));
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await allRows(t, "bookings")).toHaveLength(1);
    expect(await allRows(t, "payments")).toHaveLength(1);
    expect(await allRows(t, "financeExceptions")).toHaveLength(0);
  });

  test("second distinct payment for a converted hold -> duplicate_payment exception", async () => {
    const { t, hold } = await held();
    await t.mutation(internal.payments.recordVerified, pay(hold.holdId));
    const dup = await t.mutation(internal.payments.recordVerified, pay(hold.holdId, { externalRef: "0xdef" }));
    expect(dup.outcome).toBe("exception");
    if (dup.outcome !== "exception") throw new Error("unreachable");
    expect(dup.kind).toBe("duplicate_payment");
    expect(await allRows(t, "bookings")).toHaveLength(1);
  });

  test("payment after hold expiry -> exception, no booking", async () => {
    const { t, hold, slots } = await held();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const result = await t.mutation(internal.payments.recordVerified, pay(hold.holdId));
    expect(result.outcome).toBe("exception");
    if (result.outcome !== "exception") throw new Error("unreachable");
    expect(result.kind).toBe("payment_after_hold_expired");

    expect(await allRows(t, "bookings")).toHaveLength(0);
    const payment = await t.run(async (ctx) => await ctx.db.get(result.paymentId));
    expect(payment?.status).toBe("exception");
    const open = await t.query(api.finance.openExceptions, {});
    expect(open).toHaveLength(1);
    expect(open[0].expectedMinor).toBe(8000);
    expect(open[0].observedMinor).toBe(8000);
    const s0 = await t.run(async (ctx) => await ctx.db.get(slots[4]._id));
    expect(s0?.state).toBe("available");

    // Replay of the late payment returns the same exception.
    const replay = await t.mutation(internal.payments.recordVerified, pay(hold.holdId));
    expect(replay).toEqual({ ...result, replayed: true });
    expect(await allRows(t, "financeExceptions")).toHaveLength(1);
  });

  test("payment past expiresAt is rejected even before the expiry job runs", async () => {
    const { t, hold } = await held();
    vi.setSystemTime(hold.expiresAt + 1); // clock moves, scheduler has not fired
    const result = await t.mutation(internal.payments.recordVerified, pay(hold.holdId));
    expect(result.outcome).toBe("exception");
    if (result.outcome !== "exception") throw new Error("unreachable");
    expect(result.kind).toBe("payment_after_hold_expired");
    expect(await allRows(t, "bookings")).toHaveLength(0);
  });

  test("amount mismatch -> exception, slots stay held", async () => {
    const { t, hold, slots } = await held();
    const result = await t.mutation(internal.payments.recordVerified, pay(hold.holdId, { amountMinor: 7999 }));
    expect(result.outcome).toBe("exception");
    if (result.outcome !== "exception") throw new Error("unreachable");
    expect(result.kind).toBe("amount_mismatch");
    expect(await allRows(t, "bookings")).toHaveLength(0);
    const ex = await t.run(async (ctx) => await ctx.db.get(result.financeExceptionId));
    expect(ex?.expectedMinor).toBe(8000);
    expect(ex?.observedMinor).toBe(7999);
    const s0 = await t.run(async (ctx) => await ctx.db.get(slots[4]._id));
    expect(s0?.state).toBe("held");
  });

  test("wrong asset -> asset_mismatch exception", async () => {
    const { t, hold } = await held();
    const result = await t.mutation(internal.payments.recordVerified, pay(hold.holdId, { asset: "ETH" }));
    expect(result.outcome === "exception" && result.kind).toBe("asset_mismatch");
    expect(await allRows(t, "bookings")).toHaveLength(0);
  });

  test("unknown hold id -> rejected, nothing recorded", async () => {
    const { t } = await held();
    const result = await t.mutation(internal.payments.recordVerified, pay("not-a-real-id"));
    expect(result).toMatchObject({ outcome: "rejected", code: "HOLD_NOT_FOUND" });
    expect(await allRows(t, "payments")).toHaveLength(0);
  });
});

describe("http /internal/payments/verified", () => {
  async function post(t: TestClient, body: unknown, auth?: string) {
    return await t.fetch("/internal/payments/verified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  test("requires bearer secret, then books", async () => {
    const { t, seed, slots } = await setup();
    const q = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[0]._id] });
    const hold = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "k", actor: "buyer" });
    const body = {
      holdId: hold.holdId,
      provider: "x402",
      externalRef: "0x1",
      amountMinor: hold.amountMinor,
      asset: "USDC",
      network: "base-sepolia",
      idempotencyKey: "p1",
    };

    expect((await post(t, body)).status).toBe(401);
    expect((await post(t, body, "Bearer wrong")).status).toBe(401);
    expect((await post(t, { ...body, amountMinor: "10" }, `Bearer ${SECRET}`)).status).toBe(400);
    expect((await post(t, { ...body, holdId: "nope" }, `Bearer ${SECRET}`)).status).toBe(404);

    const ok = await post(t, body, `Bearer ${SECRET}`);
    expect(ok.status).toBe(200);
    const json = await ok.json();
    expect(json.outcome).toBe("booked");

    const replay = await post(t, body, `Bearer ${SECRET}`);
    expect((await replay.json()).replayed).toBe(true);
    expect(await allRows(t, "bookings")).toHaveLength(1);

    const holdInfo = await t.fetch(`/internal/holds?holdId=${hold.holdId}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(holdInfo.status).toBe(200);
    const holdJson = await holdInfo.json();
    expect(holdJson.status).toBe("converted");
    expect(holdJson.traceId).toBe(hold.traceId);
  });

  test("fails closed when the secret is not configured", async () => {
    const { t } = await setup();
    delete process.env.INTERNAL_API_SECRET;
    const res = await post(t, {}, "Bearer anything");
    expect(res.status).toBe(503);
  });
});
