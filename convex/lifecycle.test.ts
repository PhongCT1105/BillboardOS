import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules } from "./test.setup";

// 09:07 PDT; first seeded slot is 16:15-16:30Z.
const START = Date.UTC(2026, 9, 25, 16, 7);
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

async function setup() {
  const t = convexTest(schema, modules);
  const seed = await t.mutation(internal.seed.demo, {});
  const slots = await t.query(api.slots.listForBillboard, {
    billboardId: seed.billboardId,
    from: START,
    to: START + 24 * 60 * MIN,
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

async function bookWithManualPayment(
  t: T,
  campaignId: Id<"campaigns">,
  slotIds: Id<"slots">[],
  key: string,
) {
  const q = await t.mutation(api.quotes.create, { campaignId, slotIds });
  const hold = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: key, actor: "buyer" });
  const result = await t.mutation(api.payments.recordManual, { holdId: hold.holdId, note: "demo" });
  if (result.outcome !== "booked") throw new Error(`expected booked, got ${result.outcome}`);
  return { q, hold, result };
}

async function uploadCreative(t: T, campaignId: Id<"campaigns">) {
  const storageId = await t.run(async (ctx) =>
    ctx.storage.store(new Blob(["fake-png-bytes"], { type: "image/png" })),
  );
  await t.mutation(api.creatives.attach, { campaignId, storageId, contentType: "image/png" });
  return storageId;
}

describe("advertisers & campaigns", () => {
  test("list and create", async () => {
    const { t, seed } = await setup();
    const advertisers = await t.query(api.advertisers.list, {});
    expect(advertisers.map((a) => a.displayName).sort()).toEqual([
      "Bay Robotics",
      "Golden Gate Coffee Co.",
    ]);

    expect(
      await errorCode(
        t.mutation(api.campaigns.create, {
          advertiserId: seed.advertiserIds[1],
          brief: "Robots",
          budgetMinor: 12.5,
        }),
      ),
    ).toBe("INVALID_INPUT");

    const id = await t.mutation(api.campaigns.create, {
      advertiserId: seed.advertiserIds[1],
      brief: "Robot demo day",
      targetCity: "San Francisco",
      budgetMinor: 50_000,
    });
    const all = await t.query(api.campaigns.list, {});
    expect(all).toHaveLength(2);
    const mine = await t.query(api.campaigns.list, { advertiserId: seed.advertiserIds[1] });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      _id: id,
      advertiserName: "Bay Robotics",
      creativeStatus: "none",
      status: "active",
    });
  });
});

describe("creatives", () => {
  test("attach -> pending review with URL; rejects non-media types", async () => {
    const { t, seed } = await setup();
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["x"], { type: "text/plain" })),
    );
    expect(
      await errorCode(
        t.mutation(api.creatives.attach, {
          campaignId: seed.campaignId,
          storageId,
          contentType: "text/html",
        }),
      ),
    ).toBe("INVALID_INPUT");

    await uploadCreative(t, seed.campaignId);
    const pending = await t.query(api.creatives.pendingReview, {});
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      campaignId: seed.campaignId,
      advertiserName: "Golden Gate Coffee Co.",
      contentType: "image/png",
    });
    expect(typeof pending[0].creativeUrl).toBe("string");
    const stored = await t.run(async (ctx) => ctx.db.get(seed.campaignId));
    expect(stored?.creativeStatus).toBe("pending_review");
  });

  test("approval schedules confirmed bookings' future slots", async () => {
    const { t, seed, slots } = await setup();
    const { result } = await bookWithManualPayment(t, seed.campaignId, [slots[0]._id, slots[1]._id], "k1");
    await uploadCreative(t, seed.campaignId);

    // slot 0 has finished by the time the operator approves; slot 1 is still ahead.
    vi.setSystemTime(slots[0].endAt + MIN);
    const review = await t.mutation(api.creatives.review, {
      campaignId: seed.campaignId,
      decision: "approved",
      reason: "Brand-safe",
    });
    expect(review).toEqual({ campaignId: seed.campaignId, creativeStatus: "approved", slotsScheduled: 1 });

    const state = await t.run(async (ctx) => ({
      s0: await ctx.db.get(slots[0]._id),
      s1: await ctx.db.get(slots[1]._id),
      booking: await ctx.db.get(result.bookingId),
    }));
    expect(state.s0?.state).toBe("booked");
    expect(state.s1?.state).toBe("scheduled");
    expect(state.booking?.status).toBe("scheduled");
    expect(await t.query(api.creatives.pendingReview, {})).toHaveLength(0);

    const events = await t.query(api.audit.recent, {});
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["creative.attached", "creative.approved", "booking.scheduled"]),
    );

    // Approved creative is locked; reviewing again is refused.
    expect(
      await errorCode(
        t.mutation(api.creatives.review, { campaignId: seed.campaignId, decision: "rejected", reason: "x" }),
      ),
    ).toBe("NOT_PENDING");
  });

  test("payment after approval goes straight to scheduled", async () => {
    const { t, seed, slots } = await setup();
    await uploadCreative(t, seed.campaignId);
    await t.mutation(api.creatives.review, { campaignId: seed.campaignId, decision: "approved", reason: "ok" });
    const { result } = await bookWithManualPayment(t, seed.campaignId, [slots[2]._id], "k2");
    const state = await t.run(async (ctx) => ({
      slot: await ctx.db.get(slots[2]._id),
      booking: await ctx.db.get(result.bookingId),
    }));
    expect(state.slot?.state).toBe("scheduled");
    expect(state.booking?.status).toBe("scheduled");
  });

  test("rejection records reason and audit event", async () => {
    const { t, seed } = await setup();
    await uploadCreative(t, seed.campaignId);
    const r = await t.mutation(api.creatives.review, {
      campaignId: seed.campaignId,
      decision: "rejected",
      reason: "Illegible text",
    });
    expect(r.creativeStatus).toBe("rejected");
    const [c] = await t.query(api.campaigns.list, {});
    expect(c.creativeReviewReason).toBe("Illegible text");
    const events = await t.query(api.audit.recent, {});
    expect(events.some((e) => e.type === "creative.rejected" && e.actor === "operator")).toBe(true);
  });
});

describe("manual payments", () => {
  test("books at the held amount, labeled MANUAL, replay-safe", async () => {
    const { t, seed, slots } = await setup();
    const { hold, result } = await bookWithManualPayment(t, seed.campaignId, [slots[0]._id], "m1");
    const payment = await t.run(async (ctx) => ctx.db.get(result.paymentId));
    expect(payment).toMatchObject({
      provider: "manual",
      externalRef: `manual:${hold.holdId}`,
      amountMinor: hold.amountMinor,
      asset: "USD",
      status: "verified",
    });
    const trail = await t.query(api.audit.forTrace, { traceId: hold.traceId });
    const confirmed = trail.find((e) => e.type === "payment.confirmed")!;
    expect(confirmed.actor).toBe("operator");
    expect(confirmed.reason).toContain("MANUAL (simulated) payment");

    const again = await t.mutation(api.payments.recordManual, { holdId: hold.holdId, note: "again" });
    expect(again).toEqual({ ...result, replayed: true });
    const bookings = await t.run(async (ctx) => ctx.db.query("bookings").take(10));
    expect(bookings).toHaveLength(1);
  });

  test("manual payment on an expired hold opens an exception", async () => {
    const { t, seed, slots } = await setup();
    const q = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[0]._id] });
    const hold = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "m2", actor: "buyer" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await t.mutation(api.payments.recordManual, { holdId: hold.holdId, note: "late" });
    expect(r.outcome === "exception" && r.kind).toBe("payment_after_hold_expired");
  });
});

describe("player", () => {
  test("nowPlaying shows the approved creative only for scheduled slots, plus house ad", async () => {
    const { t, seed, slots } = await setup();
    const { result } = await bookWithManualPayment(t, seed.campaignId, [slots[0]._id], "p1");

    const during = slots[0].startAt + 5 * MIN;
    let view = await t.query(api.player.nowPlaying, { billboardId: seed.billboardId, atMinute: during });
    expect(view.current).toMatchObject({
      slotId: slots[0]._id,
      state: "booked",
      bookingId: result.bookingId,
      campaignId: seed.campaignId,
      advertiserName: "Golden Gate Coffee Co.",
    });
    expect(view.current?.creativeUrl).toBeUndefined();
    expect(view.next?.slotId).toBe(slots[1]._id);
    expect(view.next?.state).toBe("available");
    // Cheapest available slot in the next 12h (09:30-21:00 PDT), no audience data: $40 x 0.85 evening.
    expect(view.houseAd.fromPriceMinor).toBe(3400);
    expect(view.houseAd.message).toContain("Moscone West Screen");

    await uploadCreative(t, seed.campaignId);
    await t.mutation(api.creatives.review, { campaignId: seed.campaignId, decision: "approved", reason: "ok" });
    view = await t.query(api.player.nowPlaying, { billboardId: seed.billboardId, atMinute: during });
    expect(view.current?.state).toBe("scheduled");
    expect(typeof view.current?.creativeUrl).toBe("string");
    expect(view.current?.contentType).toBe("image/png");

    // Before any slot: no current slot.
    const before = await t.query(api.player.nowPlaying, {
      billboardId: seed.billboardId,
      atMinute: slots[0].startAt - 2 * MIN,
    });
    expect(before.current).toBeNull();
    expect(before.next?.slotId).toBe(slots[0]._id);
  });

  test("recordPlayback: requires scheduled, idempotent, marks slot and booking played", async () => {
    const { t, seed, slots } = await setup();
    const { result } = await bookWithManualPayment(t, seed.campaignId, [slots[0]._id], "p2");
    vi.setSystemTime(slots[0].startAt + MIN);

    expect(
      await errorCode(
        t.mutation(api.player.recordPlayback, {
          slotId: slots[0]._id,
          bookingId: result.bookingId,
          status: "played",
        }),
      ),
    ).toBe("NOT_SCHEDULED");

    await uploadCreative(t, seed.campaignId);
    await t.mutation(api.creatives.review, { campaignId: seed.campaignId, decision: "approved", reason: "ok" });

    const first = await t.mutation(api.player.recordPlayback, {
      slotId: slots[0]._id,
      bookingId: result.bookingId,
      status: "played",
    });
    expect(first).toMatchObject({ slotState: "played", replayed: false });
    const again = await t.mutation(api.player.recordPlayback, {
      slotId: slots[0]._id,
      bookingId: result.bookingId,
      status: "played",
    });
    expect(again).toEqual({ ...first, replayed: true });

    const receipts = await t.query(api.playback.recentForBillboard, { billboardId: seed.billboardId });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      bookingId: result.bookingId,
      slotId: slots[0]._id,
      campaignId: seed.campaignId,
      contentType: "image/png",
      status: "played",
    });
    const booking = await t.run(async (ctx) => ctx.db.get(result.bookingId));
    expect(booking?.status).toBe("played");

    // Creative still shows while the played slot is on air.
    const view = await t.query(api.player.nowPlaying, {
      billboardId: seed.billboardId,
      atMinute: slots[0].startAt + 2 * MIN,
    });
    expect(view.current?.state).toBe("played");
    expect(typeof view.current?.creativeUrl).toBe("string");

    const events = await t.query(api.audit.recent, {});
    expect(events.some((e) => e.type === "playback.observed")).toBe(true);
  });

  test("recordPlayback failed -> failed_delivery", async () => {
    const { t, seed, slots } = await setup();
    await uploadCreative(t, seed.campaignId);
    await t.mutation(api.creatives.review, { campaignId: seed.campaignId, decision: "approved", reason: "ok" });
    const { result } = await bookWithManualPayment(t, seed.campaignId, [slots[0]._id], "p3");
    vi.setSystemTime(slots[0].startAt + MIN);
    const r = await t.mutation(api.player.recordPlayback, {
      slotId: slots[0]._id,
      bookingId: result.bookingId,
      status: "failed",
    });
    expect(r.slotState).toBe("failed_delivery");
    const booking = await t.run(async (ctx) => ctx.db.get(result.bookingId));
    expect(booking?.status).toBe("failed");
    const events = await t.query(api.audit.recent, {});
    expect(events.some((e) => e.type === "playback.failed")).toBe(true);
  });
});

describe("rolling inventory", () => {
  test("ensureUpcoming is idempotent and tops up as time moves", async () => {
    const { t, seed } = await setup();
    expect(await t.mutation(internal.slots.ensureUpcoming, {})).toEqual({ billboards: 1, slotsCreated: 0 });
    vi.setSystemTime(START + 60 * MIN);
    expect(await t.mutation(internal.slots.ensureUpcoming, {})).toEqual({ billboards: 1, slotsCreated: 4 });
    expect(await t.mutation(internal.slots.ensureUpcoming, {})).toEqual({ billboards: 1, slotsCreated: 0 });

    const slots = await t.query(api.slots.listForBillboard, {
      billboardId: seed.billboardId,
      from: START,
      to: START + 24 * 60 * MIN,
    });
    expect(slots).toHaveLength(52);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].startAt).toBe(slots[i - 1].endAt);
    }
    // Seed re-run is still idempotent with the rolling helper.
    const again = await t.mutation(internal.seed.demo, {});
    expect(again.slotsCreated).toBe(0);
  });
});

describe("audience sparkline", () => {
  test("recentForBillboard returns buckets oldest first", async () => {
    const { t, seed } = await setup();
    for (const count of [100, 150, 90]) {
      await t.mutation(api.audience.record, {
        billboardId: seed.billboardId,
        countEstimate: count,
        source: "simulated",
        confidence: 0.6,
      });
      vi.setSystemTime(Date.now() + 15 * MIN);
    }
    const rows = await t.query(api.audience.recentForBillboard, { billboardId: seed.billboardId });
    expect(rows.map((r) => r.countEstimate)).toEqual([100, 150, 90]);
    expect(rows[0].bucketStart).toBeLessThan(rows[2].bucketStart);
  });
});
