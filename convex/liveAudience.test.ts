/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { hashKey } from "./lib/agentKeys";
import { modules, signedInCustomer, signedInOperator } from "./test.setup";

const START = Date.UTC(2026, 9, 25, 16, 7);
const WINDOW = 30_000;
const KEY = "k".repeat(64);
const AUDIENCE = { people: 7, avgInViewMs: 18_000, lookers: 4, avgLookingMs: 9_000 };

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

/** A host with paired screen "LED", its device, and Nvidia (the payer) plus another company. */
async function world() {
  const t = convexTest(schema, modules);
  const host = await signedInOperator(t, "host@venue.test");
  const ids = await t.run(async (ctx) => {
    const workspaceId = (await ctx.db.query("workspaces").withIndex("by_name", (q) => q.eq("name", "Moscone Media")).first())!._id;
    const billboardId = await ctx.db.insert("billboards", {
      workspaceId,
      name: "LED",
      city: "San Francisco",
      locationLabel: "LED at the venue",
      utcOffsetMinutes: -420,
      reserveFloorMinor: 100,
      baseRateMinor: 100,
      deviceStatus: "online",
    });
    const deviceId = await ctx.db.insert("screenDevices", {
      deviceKeyHash: await hashKey(KEY),
      pairingCode: "TEST01",
      codeExpiresAt: 0,
      billboardId,
      utcOffsetMinutes: -420,
      lastSeenAt: Date.now(),
      createdAt: Date.now(),
    });
    await ctx.db.patch(billboardId, { deviceId });
    const advertiserId = await ctx.db.insert("advertisers", { displayName: "Nvidia", paymentTerms: "prepay" });
    const otherAdvertiserId = await ctx.db.insert("advertisers", { displayName: "Golden Gate Coffee", paymentTerms: "prepay" });
    const campaignId = await ctx.db.insert("campaigns", { advertiserId, brief: "GTC week", budgetMinor: 10_000, currency: "USD", status: "active" });
    const agentKeyId = await ctx.db.insert("agentKeys", {
      advertiserId,
      name: "Nvidia agent",
      prefix: "bos_agent_test",
      keyHash: "test",
      scopes: ["bid", "pay"],
      budgetCapMinor: 10_000,
      expiresAt: Date.now() + 86_400_000,
      webhookSecret: "whsec_test",
      createdBy: "test",
    });
    return { workspaceId, billboardId, deviceId, advertiserId, otherAdvertiserId, campaignId, agentKeyId };
  });
  const payer = await signedInCustomer(t, ids.advertiserId, "buyer@nvidia.test");
  const other = await signedInCustomer(t, ids.otherAdvertiserId, "buyer@coffee.test");
  const device = { deviceId: ids.deviceId, deviceKey: KEY };

  /** A 30-second window on LED from `startAt`: paid by Nvidia, or nobody bought it (the house ad). */
  async function window(startAt: number, paid: boolean): Promise<Id<"rounds">> {
    return await t.run(async (ctx) => {
      const roundId = await ctx.db.insert("rounds", {
        workspaceId: ids.workspaceId,
        billboardId: ids.billboardId,
        spotStartAt: startAt,
        spotEndAt: startAt + WINDOW,
        trigger: "timer",
        status: paid ? "paid" : "unsold",
        floorMinor: 100,
        askingMinor: 200,
        signals: [],
        crowd: null,
        eventName: null,
        invitedCount: 1,
        closesAt: startAt,
        createdAt: startAt - WINDOW,
      });
      if (paid) {
        const bidId = await ctx.db.insert("roundBids", {
          roundId,
          advertiserId: ids.advertiserId,
          campaignId: ids.campaignId,
          agentKeyId: ids.agentKeyId,
          match: null,
          amountMinor: 200,
          status: "won",
        });
        await ctx.db.patch(roundId, { winnerBidId: bidId, priceMinor: 200 });
      }
      return roundId;
    });
  }

  return { t, host, payer, other, device, window, ...ids };
}

describe("window reports", () => {
  test("the screen reports a paid window when it ends; the host and the payer see it, nobody else", async () => {
    const w = await world();
    const roundId = await w.window(START, true);
    expect(await errorCode(w.t.mutation(api.liveAudience.reportWindow, { ...w.device, roundId, ...AUDIENCE }))).toBe("TOO_EARLY");

    vi.setSystemTime(START + WINDOW + 400);
    const first = await w.t.mutation(api.liveAudience.reportWindow, { ...w.device, roundId, ...AUDIENCE });
    expect(first.replayed).toBe(false);
    // A repeat (a retry after a lost response) returns the first report and changes nothing.
    const again = await w.t.mutation(api.liveAudience.reportWindow, { ...w.device, roundId, ...AUDIENCE, people: 99 });
    expect(again).toEqual({ reportId: first.reportId, replayed: true });

    const forScreen = await w.host.query(api.liveAudience.hostWindows, { billboardId: w.billboardId });
    expect(forScreen).toEqual([
      { roundId, billboardId: w.billboardId, screen: "LED", company: "Nvidia", spotStartAt: START, spotEndAt: START + WINDOW, audience: AUDIENCE },
    ]);
    expect(await w.host.query(api.liveAudience.hostWindows, {})).toEqual(forScreen);

    const mine = await w.payer.query(api.liveAudience.myWindows, {});
    expect(mine).toEqual([{ roundId, billboardId: w.billboardId, screen: "LED", spotStartAt: START, spotEndAt: START + WINDOW, audience: AUDIENCE }]);
    expect(await w.other.query(api.liveAudience.myWindows, {})).toEqual([]);
    expect(await errorCode(w.payer.query(api.liveAudience.hostWindows, { billboardId: w.billboardId }))).toBe("NOT_WORKSPACE_MEMBER");
  });

  test("the payer sees its paid window on air before the report arrives", async () => {
    const w = await world();
    const roundId = await w.window(START, true);
    expect(await w.payer.query(api.liveAudience.myWindows, {})).toEqual([
      { roundId, billboardId: w.billboardId, screen: "LED", spotStartAt: START, spotEndAt: START + WINDOW, audience: null },
    ]);
  });

  test("a house-ad window is reported to the host only", async () => {
    const w = await world();
    const roundId = await w.window(START, false);
    vi.setSystemTime(START + WINDOW);
    await w.t.mutation(api.liveAudience.reportWindow, { ...w.device, roundId, people: 3, avgInViewMs: 12_000, lookers: null, avgLookingMs: null });
    const rows = await w.host.query(api.liveAudience.hostWindows, {});
    expect(rows.map((r) => [r.company, r.audience])).toEqual([[null, { people: 3, avgInViewMs: 12_000, lookers: null, avgLookingMs: null }]]);
    expect(await w.payer.query(api.liveAudience.myWindows, {})).toEqual([]);
  });

  test("only the screen's own device reports, with sensible numbers", async () => {
    const w = await world();
    const roundId = await w.window(START, true);
    vi.setSystemTime(START + WINDOW);
    const report = (extra: { deviceKey?: string; people?: number; avgInViewMs?: number; lookers?: number | null; avgLookingMs?: number | null }) =>
      w.t.mutation(api.liveAudience.reportWindow, { ...w.device, roundId, ...AUDIENCE, ...extra });

    expect(await errorCode(report({ deviceKey: "x".repeat(64) }))).toBe("NOT_FOUND");
    expect(await errorCode(report({ lookers: 8 }))).toBe("INVALID_INPUT");
    expect(await errorCode(report({ people: 2.5 }))).toBe("INVALID_INPUT");
    expect(await errorCode(report({ avgLookingMs: null }))).toBe("INVALID_INPUT");
    expect(await errorCode(report({ avgInViewMs: -1 }))).toBe("INVALID_INPUT");

    // A screen on another host's round can't report it.
    const otherScreen = await w.t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", { name: "Elsewhere", city: "Oakland" });
      const billboardId = await ctx.db.insert("billboards", {
        workspaceId,
        name: "Other",
        city: "Oakland",
        locationLabel: "Elsewhere",
        utcOffsetMinutes: -420,
        reserveFloorMinor: 100,
        baseRateMinor: 100,
        deviceStatus: "online",
      });
      return await ctx.db.insert("screenDevices", {
        deviceKeyHash: await hashKey("o".repeat(64)),
        pairingCode: "TEST02",
        codeExpiresAt: 0,
        billboardId,
        utcOffsetMinutes: -420,
        lastSeenAt: Date.now(),
        createdAt: Date.now(),
      });
    });
    expect(await errorCode(w.t.mutation(api.liveAudience.reportWindow, { deviceId: otherScreen, deviceKey: "o".repeat(64), roundId, ...AUDIENCE }))).toBe("NOT_FOUND");

    // The screen ticks a little past the window: nobody is in view longer than the window itself.
    await report({ avgInViewMs: WINDOW + 400, avgLookingMs: WINDOW + 400 });
    const [row] = await w.host.query(api.liveAudience.hostWindows, {});
    expect(row.audience.avgInViewMs).toBe(WINDOW);
    expect(row.audience.avgLookingMs).toBe(WINDOW);
  });

  test("a report long after the window ended is refused", async () => {
    const w = await world();
    const roundId = await w.window(START, true);
    vi.setSystemTime(START + WINDOW + 6 * 60_000);
    expect(await errorCode(w.t.mutation(api.liveAudience.reportWindow, { ...w.device, roundId, ...AUDIENCE }))).toBe("TOO_LATE");
  });
});

describe("live view", () => {
  const FRAME = { boxes: [{ x: 0.1, y: 0.2, w: 0.2, h: 0.5, looking: true }], inView: 1, looking: 1 };

  test("the host can open it any time; the payer only while its ad is on air; nobody else", async () => {
    const w = await world();
    await w.window(START, true);
    vi.setSystemTime(START + 5_000);
    expect((await w.host.mutation(api.liveAudience.watch, { billboardId: w.billboardId })).role).toBe("host");
    expect((await w.payer.mutation(api.liveAudience.watch, { billboardId: w.billboardId })).role).toBe("payer");
    expect(await errorCode(w.other.mutation(api.liveAudience.watch, { billboardId: w.billboardId }))).toBe("NOT_ON_AIR");
    expect(await errorCode(w.t.mutation(api.liveAudience.watch, { billboardId: w.billboardId }))).toBe("UNAUTHENTICATED");

    vi.setSystemTime(START + WINDOW + 1);
    expect(await errorCode(w.payer.mutation(api.liveAudience.watch, { billboardId: w.billboardId }))).toBe("NOT_ON_AIR");
    expect((await w.host.mutation(api.liveAudience.watch, { billboardId: w.billboardId })).role).toBe("host");
  });

  test("the screen sends boxes only while someone watches; the payer sees only frames from its own window", async () => {
    const w = await world();
    await w.window(START, true);
    vi.setSystemTime(START + 5_000);

    // Nobody watching: nothing is stored.
    expect(await w.t.query(api.liveAudience.wanted, { deviceId: w.deviceId })).toBe(0);
    expect(await w.t.mutation(api.liveAudience.pushFrame, { ...w.device, ...FRAME })).toEqual({ wanted: false });
    expect(await w.host.query(api.liveAudience.view, { billboardId: w.billboardId })).toBeNull();

    const { until } = await w.payer.mutation(api.liveAudience.watch, { billboardId: w.billboardId });
    expect(await w.t.query(api.liveAudience.wanted, { deviceId: w.deviceId })).toBe(until);
    expect(await w.t.mutation(api.liveAudience.pushFrame, { ...w.device, ...FRAME })).toEqual({ wanted: true });
    const seen = await w.payer.query(api.liveAudience.view, { billboardId: w.billboardId });
    expect(seen).toEqual({ ...FRAME, at: expect.any(Number) });
    expect(await w.host.query(api.liveAudience.view, { billboardId: w.billboardId })).toEqual(seen);
    expect(await w.other.query(api.liveAudience.view, { billboardId: w.billboardId })).toBeNull();

    // The window is over; the host keeps watching. Its new frames aren't the payer's to see.
    vi.setSystemTime(START + WINDOW + 1_000);
    await w.host.mutation(api.liveAudience.watch, { billboardId: w.billboardId });
    await w.t.mutation(api.liveAudience.pushFrame, { ...w.device, ...FRAME, inView: 2, looking: 0 });
    expect(await w.payer.query(api.liveAudience.view, { billboardId: w.billboardId })).toBeNull();
    expect((await w.host.query(api.liveAudience.view, { billboardId: w.billboardId }))?.inView).toBe(2);

    // Everyone closed the pop-up: once the request runs out, the screen is told to stop.
    vi.setSystemTime(START + WINDOW + 30_000);
    expect(await w.t.mutation(api.liveAudience.pushFrame, { ...w.device, ...FRAME })).toEqual({ wanted: false });
  });

  test("frames are boxes inside the frame, with whole counts", async () => {
    const w = await world();
    await w.host.mutation(api.liveAudience.watch, { billboardId: w.billboardId });
    const push = (frame: typeof FRAME) => w.t.mutation(api.liveAudience.pushFrame, { ...w.device, ...frame });
    expect(await errorCode(push({ ...FRAME, boxes: [{ x: 1.2, y: 0, w: 0.1, h: 0.1, looking: false }] }))).toBe("INVALID_INPUT");
    expect(await errorCode(push({ ...FRAME, inView: 1, looking: 2 }))).toBe("INVALID_INPUT");
    expect(await errorCode(push({ ...FRAME, boxes: Array.from({ length: 21 }, () => FRAME.boxes[0]) }))).toBe("INVALID_INPUT");
    expect(await errorCode(w.t.mutation(api.liveAudience.pushFrame, { ...w.device, deviceKey: "x".repeat(64), ...FRAME }))).toBe("NOT_FOUND");
  });
});
