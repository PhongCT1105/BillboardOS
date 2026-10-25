import { describe, expect, test } from "vitest";
import {
  ACTIVE_INVITE_LIMIT,
  REJECT_STREAK_THRESHOLD,
  applyOutcome,
  coolDownUntil,
  isCooled,
  outcomeFromBidStatus,
  rankMatch,
  rankTopInvites,
} from "./lib/inviteRoster";
import { WINDOW_MS } from "./lib/rounds";

describe("inviteRoster", () => {
  test("rankMatch treats null as neutral", () => {
    expect(rankMatch(null)).toBe(0.5);
    expect(rankMatch(0.9)).toBe(0.9);
  });

  test("rankTopInvites takes highest match then pref weight", () => {
    const top = rankTopInvites(
      [
        { advertiserId: "a", match: 0.4, prefWeight: 5 },
        { advertiserId: "b", match: 0.9, prefWeight: 0 },
        { advertiserId: "c", match: 0.9, prefWeight: 2 },
        { advertiserId: "d", match: null, prefWeight: 99 },
        { advertiserId: "e", match: 0.2 },
      ],
      3,
    );
    expect(top.map((x) => x.advertiserId)).toEqual(["c", "b", "d"]);
  });

  test("rankTopInvites respects ACTIVE_INVITE_LIMIT default", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      advertiserId: `c${i}`,
      match: i / 20,
    }));
    expect(rankTopInvites(many)).toHaveLength(ACTIVE_INVITE_LIMIT);
    expect(rankTopInvites(many)[0]!.advertiserId).toBe("c19");
  });

  test("reject streak cools after threshold and resets on agree", () => {
    const now = 1_000_000;
    let s = applyOutcome(null, "reject", now);
    expect(s.rejectStreak).toBe(1);
    expect(s.cooledUntilAt).toBeUndefined();
    for (let i = 1; i < REJECT_STREAK_THRESHOLD; i++) s = applyOutcome(s, "reject", now);
    expect(s.rejectStreak).toBe(REJECT_STREAK_THRESHOLD);
    expect(s.cooledUntilAt).toBe(coolDownUntil(now));
    expect(isCooled(s, now)).toBe(true);
    expect(isCooled(s, coolDownUntil(now))).toBe(false);
    expect(isCooled(s, coolDownUntil(now) - 1)).toBe(true);
    s = applyOutcome(s, "agreed", now + WINDOW_MS);
    expect(s).toEqual({ rejectStreak: 0 });
  });

  test("outcomeFromBidStatus maps statuses", () => {
    expect(outcomeFromBidStatus("won", false)).toBe("agreed");
    expect(outcomeFromBidStatus("bid", false)).toBe("agreed");
    expect(outcomeFromBidStatus("passed", false)).toBe("reject");
    expect(outcomeFromBidStatus("lost", false)).toBe("reject");
    expect(outcomeFromBidStatus("lost", true)).toBe("agreed");
  });
});
