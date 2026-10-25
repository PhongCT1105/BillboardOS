import { describe, expect, test } from "vitest";
import { checkBid, extendLive, joinOutcome, minNextLiveBid, type JoinReply } from "./lib/liveAuction";

describe("minNextLiveBid", () => {
  test("opening price without a leader, then 5% steps with a 5 cent floor", () => {
    expect(minNextLiveBid({ leaderMinor: null, openingMinor: 72 })).toBe(72);
    expect(minNextLiveBid({ leaderMinor: 72, openingMinor: 72 })).toBe(77);
    expect(minNextLiveBid({ leaderMinor: 77, openingMinor: 72 })).toBe(82);
    expect(minNextLiveBid({ leaderMinor: 200, openingMinor: 72 })).toBe(210);
  });
});

describe("extendLive", () => {
  test("a bid in the last 3 s extends by 3 s, at most twice", () => {
    expect(extendLive({ now: 10_000, closesAt: 12_000, extensions: 0 })).toEqual({ closesAt: 15_000, extensions: 1 });
    expect(extendLive({ now: 10_000, closesAt: 14_000, extensions: 0 })).toEqual({ closesAt: 14_000, extensions: 0 });
    expect(extendLive({ now: 10_000, closesAt: 12_000, extensions: 2 })).toEqual({ closesAt: 12_000, extensions: 2 });
  });
});

const r = (offerId: string, status: JoinReply["status"], amountMinor: number | null, repliedAt: number | null): JoinReply => ({ offerId, status, amountMinor, repliedAt });

describe("joinOutcome", () => {
  test("two accepted plus a counter is an auction with all three", () => {
    const o = joinOutcome([r("a", "accepted", 72, 1), r("b", "accepted", 72, 2), r("c", "countered", 40, 3)]);
    expect(o).toEqual({ kind: "auction", participantIds: ["a", "b", "c"] });
  });
  test("one accepted is a sale at its amount", () => {
    expect(joinOutcome([r("a", "accepted", 72, 1), r("c", "countered", 40, 3)])).toEqual({ kind: "sale", offerId: "a", amountMinor: 72 });
  });
  test("no accepted: negotiation with the highest counter, earliest wins ties", () => {
    expect(joinOutcome([r("a", "countered", 40, 1), r("b", "countered", 55, 2)])).toEqual({ kind: "negotiation", offerId: "b", amountMinor: 55 });
    expect(joinOutcome([r("a", "countered", 55, 5), r("b", "countered", 55, 2)])).toEqual({ kind: "negotiation", offerId: "b", amountMinor: 55 });
  });
  test("all passed is none", () => {
    expect(joinOutcome([r("a", "passed", null, 1), r("b", "expired", null, null), r("c", "sent", null, null)])).toEqual({ kind: "none" });
  });
});

describe("checkBid", () => {
  const ok = { phase: "bidding", now: 5_000, closesAt: 10_000, bidCount: 0, isLeader: false, amountMinor: 77, minNextMinor: 77 };
  test("error codes in order", () => {
    expect(checkBid({ ...ok, phase: "joining", bidCount: 5, isLeader: true, amountMinor: 1 })).toBe("NOT_BIDDING");
    expect(checkBid({ ...ok, now: 10_000, bidCount: 5, isLeader: true, amountMinor: 1 })).toBe("BIDDING_CLOSED");
    expect(checkBid({ ...ok, bidCount: 5, isLeader: true, amountMinor: 1 })).toBe("BID_LIMIT");
    expect(checkBid({ ...ok, isLeader: true, amountMinor: 1 })).toBe("ALREADY_LEADING");
    expect(checkBid({ ...ok, amountMinor: 76 })).toBe("BID_TOO_LOW");
  });
  test("a valid bid passes", () => {
    expect(checkBid(ok)).toBeNull();
  });
});
