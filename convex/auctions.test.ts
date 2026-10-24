import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, signedInOperator, type TestClient, joinCompanies } from "./test.setup";
import { increment, minNextBid, resolveProxy, extendForSoftClose } from "./lib/auction";

// 09:07 PDT. slots[8] airs 11:15 local (2h out): base $40, no stage moves it -> reserve $40.00.
const START = Date.UTC(2026, 9, 25, 16, 7);
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
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
  const op = await signedInOperator(anon);
  const seed = await op.mutation(internal.seed.demo, {});
  await joinCompanies(op);
  const slots = await anon.query(api.slots.listForBillboard, {
    billboardId: seed.billboardId,
    from: START,
    to: START + 24 * 60 * MIN,
  });
  // Campaign A: Golden Gate Coffee ($300 budget). Campaign B: Bay Robotics ($1,000 budget).
  const campaignA = seed.campaignId;
  const campaignB = await op.mutation(api.campaigns.create, {
    advertiserId: seed.advertiserIds[1],
    brief: "Robot demo day",
    budgetMinor: 100_000,
  });
  return { anon, op, seed, slots, campaignA, campaignB };
}

async function openOn(op: TestClient, slotId: Id<"slots">) {
  const { auctionId } = await op.mutation(api.auctions.open, { slotIds: [slotId], durationMinutes: 2 });
  return auctionId;
}

async function joinBoth(op: TestClient, auctionId: Id<"auctions">, campaignA: Id<"campaigns">, campaignB: Id<"campaigns">) {
  const a = await op.mutation(api.auctions.join, { auctionId, campaignId: campaignA });
  const b = await op.mutation(api.auctions.join, { auctionId, campaignId: campaignB });
  const A = { auctionId, campaignId: campaignA, bidderKey: a.bidderKey };
  const B = { auctionId, campaignId: campaignB, bidderKey: b.bidderKey };
  return { a, b, A, B };
}

describe("auction engine (pure)", () => {
  test("increment is 5% rounded up, at least $1", () => {
    expect(increment(4000)).toBe(200);
    expect(increment(1000)).toBe(100);
    expect(increment(7001)).toBe(351);
    expect(minNextBid({ hasLeader: false, currentMinor: 4000, reserveMinor: 4000 })).toBe(4000);
    expect(minNextBid({ hasLeader: true, currentMinor: 7000, reserveMinor: 4000 })).toBe(7350);
  });

  test("proxy resolution: leader pays one increment over the runner-up, ties go to the earlier max", () => {
    const r = resolveProxy(
      [
        { id: "a", effectiveMaxMinor: 7000, manualTopMinor: 5200, maxSetAt: 1 },
        { id: "b", effectiveMaxMinor: 9500, manualTopMinor: 5500, maxSetAt: 2 },
      ],
      4000,
    );
    expect(r).toMatchObject({ leaderId: "b", priceMinor: 7350, secondId: "a" });
    const tie = resolveProxy(
      [
        { id: "late", effectiveMaxMinor: 6000, manualTopMinor: 0, maxSetAt: 5 },
        { id: "early", effectiveMaxMinor: 6000, manualTopMinor: 0, maxSetAt: 3 },
      ],
      4000,
    );
    expect(tie).toMatchObject({ leaderId: "early", priceMinor: 6000 });
    expect(resolveProxy([{ id: "x", effectiveMaxMinor: 3000, manualTopMinor: 3000, maxSetAt: 1 }], 4000).leaderId).toBeNull();
  });

  test("soft close extends by 30 s, never past the hard cap", () => {
    expect(extendForSoftClose(1000, 100_000, 300_000)).toBe(100_000);
    expect(extendForSoftClose(80_000, 100_000, 300_000)).toBe(110_000);
    expect(extendForSoftClose(290_000, 299_000, 300_000)).toBe(300_000);
  });
});

describe("auctions", () => {
  test("ADR example: manual + proxy bids clear at one increment over the runner-up; ladder never shows maxima", async () => {
    const { anon, op, slots, campaignA, campaignB } = await world();
    const auctionId = await openOn(op, slots[8]._id);
    const view0 = await anon.query(api.auctions.forSlot, { slotId: slots[8]._id });
    expect(view0).toMatchObject({ status: "open", reserveMinor: 4000, currentMinor: 4000, leaderLabel: null, minNextBidMinor: 4000 });

    const { a, b, A, B } = await joinBoth(op, auctionId, campaignA, campaignB);
    expect([a.bidderLabel, b.bidderLabel]).toEqual(["Bidder A", "Bidder B"]);

    expect(await errorCode(op.mutation(api.auctions.bid, { ...A, amountMinor: 3900 }))).toBe("BID_TOO_LOW");
    let r = await op.mutation(api.auctions.bid, { ...A, amountMinor: 5200 });
    expect(r).toMatchObject({ leading: true, currentMinor: 5200, minNextBidMinor: 5460 });
    expect(await errorCode(op.mutation(api.auctions.bid, { ...A, amountMinor: 6000 }))).toBe("ALREADY_LEADING");
    await op.mutation(api.auctions.setAutoBid, { ...A, maxMinor: 7000 });

    expect(await errorCode(op.mutation(api.auctions.bid, { ...B, amountMinor: 5400 }))).toBe("BID_TOO_LOW");
    r = await op.mutation(api.auctions.bid, { ...B, amountMinor: 5500 });
    // A's proxy answers: 5500 + 5% = 5775.
    expect(r).toMatchObject({ leading: false, leaderLabel: "Bidder A", currentMinor: 5775 });
    r = await op.mutation(api.auctions.setAutoBid, { ...B, maxMinor: 9500 });
    expect(r).toMatchObject({ leading: true, leaderLabel: "Bidder B", currentMinor: 7350 });

    const view = (await anon.query(api.auctions.live, { now: Date.now() }))[0];
    expect(view.ladder.map((l) => [l.bidderLabel, l.amountMinor, l.isAuto])).toEqual([
      ["Bidder B", 7350, true],
      ["Bidder A", 7000, true],
      ["Bidder A", 5775, true],
      ["Bidder B", 5500, false],
      ["Bidder A", 5200, false],
    ]);
    // Private maxima never leave the server through public views.
    expect(JSON.stringify(await anon.query(api.auctions.live, { now: Date.now() }))).not.toContain("9500");
    const mine = await op.query(api.auctions.myStatus, B);
    expect(mine).toMatchObject({ outcome: "leading", myMaxMinor: 9500 });
    const theirs = await op.query(api.auctions.myStatus, A);
    expect(theirs).toMatchObject({ outcome: "outbid", myMaxMinor: 7000 });

    // Leader can't lower its max below the current price.
    expect(await errorCode(op.mutation(api.auctions.setAutoBid, { ...B, maxMinor: 7000 }))).toBe("AUTO_BID_TOO_LOW");
  });

  test("bidder keys: a buyer can't bid as another campaign", async () => {
    const { anon, op, seed, slots, campaignA, campaignB } = await world();
    const auctionId = await openOn(op, slots[8]._id);
    const { A, B } = await joinBoth(op, auctionId, campaignA, campaignB);
    expect(await errorCode(op.mutation(api.auctions.bid, { ...A, bidderKey: B.bidderKey, amountMinor: 5000 }))).toBe("FORBIDDEN");
    expect(await errorCode(op.mutation(api.auctions.bid, { ...A, bidderKey: "nope", amountMinor: 5000 }))).toBe("FORBIDDEN");
    // Re-joining without the original key is refused; with it, idempotent.
    expect(await errorCode(op.mutation(api.auctions.join, { auctionId, campaignId: campaignA }))).toBe("ALREADY_JOINED");
    const key = "client-supplied-key-123456";
    const campaignC = await op.mutation(api.campaigns.create, {
      advertiserId: seed.advertiserIds[1],
      brief: "third bidder",
      budgetMinor: 50_000,
    });
    const j1 = await op.mutation(api.auctions.join, { auctionId, campaignId: campaignC, clientKey: key });
    const j2 = await op.mutation(api.auctions.join, { auctionId, campaignId: campaignC, clientKey: key });
    expect(j2.participantId).toBe(j1.participantId);
  });

  test("budget cap applies to bids, auto-bids and joining", async () => {
    const { anon, op, slots, campaignA, campaignB } = await world();
    const auctionId = await openOn(op, slots[8]._id);
    const { A } = await joinBoth(op, auctionId, campaignA, campaignB);
    expect(await errorCode(op.mutation(api.auctions.bid, { ...A, amountMinor: 30_001 }))).toBe("BUDGET_EXCEEDED");
    expect(await errorCode(op.mutation(api.auctions.setAutoBid, { ...A, maxMinor: 40_000 }))).toBe("BUDGET_EXCEEDED");
    await op.mutation(api.auctions.setAutoBid, { ...A, maxMinor: 30_000 });

    const poor = await op.mutation(api.campaigns.create, {
      advertiserId: (await op.query(api.advertisers.list, {}))[0]._id,
      brief: "tiny",
      budgetMinor: 1000,
    });
    expect(await errorCode(op.mutation(api.auctions.join, { auctionId, campaignId: poor }))).toBe("BUDGET_EXCEEDED");
  });

  test("ties: equal maxima -> the earlier one leads at that amount", async () => {
    const { anon, op, slots, campaignA, campaignB } = await world();
    const auctionId = await openOn(op, slots[8]._id);
    const { A, B } = await joinBoth(op, auctionId, campaignA, campaignB);
    await op.mutation(api.auctions.setAutoBid, { ...A, maxMinor: 6000 });
    vi.advanceTimersByTime(1000);
    const r = await op.mutation(api.auctions.setAutoBid, { ...B, maxMinor: 6000 });
    expect(r).toMatchObject({ leading: false, leaderLabel: "Bidder A", currentMinor: 6000 });
  });

  test("soft close: a late bid extends 30 s, capped at the hard end; bids after close are refused", async () => {
    const { anon, op, slots, campaignA, campaignB } = await world();
    const auctionId = await openOn(op, slots[8]._id);
    const { A, B } = await joinBoth(op, auctionId, campaignA, campaignB);
    const opened = (await anon.query(api.auctions.forSlot, { slotId: slots[8]._id }))!;
    expect(opened.hardEndsAt - opened.endsAt).toBe(3 * MIN);

    vi.setSystemTime(opened.endsAt - 10_000);
    const r = await op.mutation(api.auctions.bid, { ...A, amountMinor: 4000 });
    expect(r.endsAt).toBe(opened.endsAt + 20_000);

    // Keep bidding in the final seconds until the hard cap stops extensions.
    let endsAt = r.endsAt;
    let turn = 0;
    while (endsAt < opened.hardEndsAt && turn < 20) {
      vi.setSystemTime(endsAt - 5_000);
      const who = turn % 2 === 0 ? B : A;
      const view = (await anon.query(api.auctions.forSlot, { slotId: slots[8]._id }))!;
      endsAt = (await op.mutation(api.auctions.bid, { ...who, amountMinor: view.minNextBidMinor })).endsAt;
      turn++;
    }
    expect(endsAt).toBe(opened.hardEndsAt);
    vi.setSystemTime(opened.hardEndsAt + 1);
    const view = (await anon.query(api.auctions.forSlot, { slotId: slots[8]._id }))!;
    expect(await errorCode(op.mutation(api.auctions.bid, { ...A, amountMinor: view.minNextBidMinor * 2 }))).toBe("AUCTION_CLOSED");
    expect(view.extensions).toBeGreaterThan(1);
  });

  test("posted price is blocked while the auction is open", async () => {
    const { anon, op, seed, slots } = await world();
    const early = await op.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[8]._id] });
    await openOn(op, slots[8]._id);
    expect(await errorCode(op.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[8]._id] }))).toBe(
      "AUCTION_OPEN",
    );
    expect(
      await errorCode(op.mutation(api.holds.create, { quoteId: early.quoteId, idempotencyKey: "early", actor: "buyer" })),
    ).toBe("AUCTION_OPEN");
  });

  test("no bid at reserve -> failed; slot returns to posted sale", async () => {
    const { anon, op, seed, slots } = await world();
    const auctionId = await openOn(op, slots[8]._id);
    const auction = (await anon.query(api.auctions.forSlot, { slotId: slots[8]._id }))!;
    vi.setSystemTime(auction.endsAt + 1);
    await op.mutation(internal.auctions.close, { auctionId });
    expect((await anon.query(api.auctions.forSlot, { slotId: slots[8]._id }))!.status).toBe("failed");
    await expect(op.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[8]._id] })).resolves.toBeDefined();
  });

  test("close -> winner hold at the winning bid -> paid -> settled", async () => {
    const { anon, op, slots, campaignA, campaignB } = await world();
    const auctionId = await openOn(op, slots[8]._id);
    const { A, B } = await joinBoth(op, auctionId, campaignA, campaignB);
    await op.mutation(api.auctions.setAutoBid, { ...A, maxMinor: 7000 });
    await op.mutation(api.auctions.setAutoBid, { ...B, maxMinor: 9500 });
    const before = (await anon.query(api.auctions.forSlot, { slotId: slots[8]._id }))!;
    vi.setSystemTime(before.endsAt + 1);
    await op.mutation(internal.auctions.close, { auctionId });

    const won = await op.query(api.auctions.myStatus, B);
    expect(won).toMatchObject({ outcome: "won", amountMinor: 7350 });
    expect(won.holdId).not.toBeNull();
    expect(won.holdKey).toMatch(/^ah_/);
    expect(await op.query(api.auctions.myStatus, A)).toMatchObject({ outcome: "lost", holdId: null, holdKey: null });
    const hold = await anon.run(async (ctx) => ctx.db.get(won.holdId!));
    expect(hold).toMatchObject({ amountMinor: 7350, status: "active", auctionId });
    const slot = await anon.run(async (ctx) => ctx.db.get(slots[8]._id));
    expect(slot?.state).toBe("held");

    // Normal payment path; amount must equal the winning bid.
    const paid = await op.mutation(internal.payments.recordVerified, {
      holdId: won.holdId!,
      provider: "x402",
      externalRef: "0xauction",
      amountMinor: 7350,
      asset: "USDC",
      idempotencyKey: "pay-auction",
    });
    expect(paid.outcome).toBe("booked");
    const after = (await anon.query(api.auctions.forSlot, { slotId: slots[8]._id }))!;
    expect(after).toMatchObject({ status: "settled", winnerLabel: "Bidder B", winningBidMinor: 7350 });
    const sales = await anon.run(async (ctx) => ctx.db.query("priceHistory").collect());
    expect(sales.map((s) => s.kind)).toEqual(["auction"]);
  });

  test("winner doesn't pay -> winner_default exception, runner-up offered at their last bid", async () => {
    const { anon, op, slots, campaignA, campaignB } = await world();
    const auctionId = await openOn(op, slots[8]._id);
    const { A, B } = await joinBoth(op, auctionId, campaignA, campaignB);
    await op.mutation(api.auctions.bid, { ...A, amountMinor: 5200 });
    await op.mutation(api.auctions.setAutoBid, { ...A, maxMinor: 7000 });
    await op.mutation(api.auctions.setAutoBid, { ...B, maxMinor: 9500 });
    const before = (await anon.query(api.auctions.forSlot, { slotId: slots[8]._id }))!;
    vi.setSystemTime(before.endsAt + 1);
    await op.mutation(internal.auctions.close, { auctionId });
    const won = await op.query(api.auctions.myStatus, B);

    // B's hold lapses: holds.expire hands off to the auction.
    const hold = (await anon.run(async (ctx) => ctx.db.get(won.holdId!)))!;
    vi.setSystemTime(hold.expiresAt + 1);
    await op.mutation(internal.holds.expire, { holdId: hold._id });
    const scheduled = await anon.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s) => s.name.includes("handleWinnerDefault") && s.state.kind === "pending")).toBe(true);
    await op.mutation(internal.auctions.handleWinnerDefault, { auctionId, holdId: hold._id });

    expect(await op.query(api.auctions.myStatus, B)).toMatchObject({ outcome: "defaulted" });
    const offer = await op.query(api.auctions.myStatus, A);
    expect(offer).toMatchObject({ outcome: "won", amountMinor: 7000 });
    const offerHold = (await anon.run(async (ctx) => ctx.db.get(offer.holdId!)))!;
    expect(offerHold).toMatchObject({ amountMinor: 7000, status: "active", auctionId });

    const exceptions = await op.query(api.finance.openExceptions, {});
    const ex = exceptions.find((e) => e.kind === "winner_default")!;
    expect(ex).toMatchObject({ expectedMinor: 7350, observedMinor: 0, holdId: hold._id });
    const trail = await op.query(api.audit.recent, {});
    expect(trail.map((e) => e.type)).toEqual(expect.arrayContaining(["auction.winner_default", "auction.runner_up_offered"]));

    // Runner-up can also release (decline) -> no one left -> failed.
    await op.mutation(api.holds.release, { holdId: offerHold._id, idempotencyKey: offer.holdKey! });
    await op.mutation(internal.auctions.handleWinnerDefault, { auctionId, holdId: offerHold._id });
    expect((await anon.query(api.auctions.forSlot, { slotId: slots[8]._id }))!.status).toBe("failed");
  });

  test("seller agent opens an auction when two buyers quote the same slot", async () => {
    const { anon, seed, slots, campaignB, op } = await world();
    await op.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[10]._id] });
    expect(await anon.query(api.auctions.forSlot, { slotId: slots[10]._id })).toBeNull();
    await op.mutation(api.quotes.create, { campaignId: campaignB, slotIds: [slots[10]._id] });
    await anon.finishInProgressScheduledFunctions();
    vi.advanceTimersByTime(1);
    await anon.finishInProgressScheduledFunctions();
    const view = await anon.query(api.auctions.forSlot, { slotId: slots[10]._id });
    expect(view).toMatchObject({ status: "open" });
    expect(view!.openReason).toContain("2 buyers are competing");
    // From now on the posted price is closed for that slot.
    expect(await errorCode(op.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[10]._id] }))).toBe(
      "AUCTION_OPEN",
    );
  });

  test("operator-only opening", async () => {
    const { anon, slots, op } = await world();
    expect(await errorCode(anon.mutation(api.auctions.open, { slotIds: [slots[8]._id] }))).toBe("UNAUTHENTICATED");
  });
});
