import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { joinCompanies, modules, signedInOperator } from "./test.setup";
import { HOLD_TTL_MS } from "./lib/constants";

// Same clock as booking.test.ts: 09:07 PDT, first seeded slot at 09:15 PDT.
const START = Date.UTC(2026, 9, 25, 16, 7);
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = await signedInOperator(convexTest(schema, modules));
  const seed = await t.mutation(internal.seed.demo, {});
  // Quotes and holds are for the campaign's own company: act for the seeded advertisers too.
  await joinCompanies(t);
  const slots = await t.query(api.slots.listForBillboard, {
    billboardId: seed.billboardId,
    from: START,
    to: START + 24 * HOUR,
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

describe("quotes.estimates", () => {
  test("prices open slots the way a quote does, and skips held ones", async () => {
    const { t, seed, slots } = await setup();
    const args = { billboardId: seed.billboardId, from: START, to: START + 12 * HOUR, now: START, campaignId: seed.campaignId };

    const before = await t.query(api.quotes.estimates, args);
    const estimate = before.find((e) => e.slotId === slots[4]._id);
    const quote = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[4]._id] });
    expect(estimate?.amountMinor).toBe(quote.priceBreakdown[0].screenMinor);

    await t.mutation(api.holds.create, { quoteId: quote.quoteId, idempotencyKey: "estimate-hold", actor: "buyer" });
    const after = await t.query(api.quotes.estimates, args);
    expect(after.some((e) => e.slotId === slots[4]._id)).toBe(false);
    expect(after.some((e) => e.slotId === slots[5]._id)).toBe(true);
  });

  test("rejects a window longer than a day", async () => {
    const { t, seed } = await setup();
    const code = await errorCode(
      t.query(api.quotes.estimates, { billboardId: seed.billboardId, from: START, to: START + 25 * HOUR, now: START }),
    );
    expect(code).toBe("INVALID_INPUT");
  });
});

describe("holds.receipt", () => {
  async function holdOne() {
    const { t, seed, slots } = await setup();
    const quote = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[4]._id] });
    const hold = await t.mutation(api.holds.create, { quoteId: quote.quoteId, idempotencyKey: "receipt-key", actor: "buyer" });
    return { t, hold };
  }

  test("only the holder sees it; a verified payment shows as booked", async () => {
    const { t, hold } = await holdOne();
    expect(await t.query(api.holds.receipt, { holdId: hold.holdId, idempotencyKey: "someone-else" })).toBeNull();
    expect(await t.query(api.holds.receipt, { holdId: hold.holdId, idempotencyKey: "receipt-key" })).toEqual({
      holdStatus: "active",
      payments: [],
    });

    await t.mutation(internal.payments.recordVerified, {
      holdId: hold.holdId,
      provider: "x402",
      externalRef: "0xreceipt",
      amountMinor: hold.amountMinor,
      asset: "USDC",
      network: "eip155:84532",
      idempotencyKey: "x402:0xreceipt",
    });
    const paid = await t.query(api.holds.receipt, { holdId: hold.holdId, idempotencyKey: "receipt-key" });
    expect(paid?.holdStatus).toBe("converted");
    expect(paid?.payments).toHaveLength(1);
    expect(paid?.payments[0]).toMatchObject({
      provider: "x402",
      externalRef: "0xreceipt",
      network: "eip155:84532",
      amountMinor: hold.amountMinor,
      exception: null,
    });
    expect(paid?.payments[0].bookingId).not.toBeNull();
  });

  test("a payment after the hold ran out shows as an open exception, not a booking", async () => {
    const { t, hold } = await holdOne();
    vi.advanceTimersByTime(HOLD_TTL_MS + 1000);
    await t.mutation(internal.payments.recordVerified, {
      holdId: hold.holdId,
      provider: "x402",
      externalRef: "0xlate",
      amountMinor: hold.amountMinor,
      asset: "USDC",
      network: "eip155:84532",
      idempotencyKey: "x402:0xlate",
    });
    const receipt = await t.query(api.holds.receipt, { holdId: hold.holdId, idempotencyKey: "receipt-key" });
    expect(receipt?.payments[0]).toMatchObject({
      bookingId: null,
      exception: { kind: "payment_after_hold_expired", status: "open" },
    });
  });
});
