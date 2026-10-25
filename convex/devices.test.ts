import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules, signedInOperator } from "./test.setup";

const START = Date.UTC(2026, 9, 25, 16, 7);
const KEY = "k".repeat(64);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code: string }).code;
    throw error;
  }
  throw new Error("expected promise to reject");
}

describe("devices: one device = one screen", () => {
  test("register shows a code; the host claims it; heartbeats keep it online; silence takes it offline", async () => {
    const t = convexTest(schema, modules);
    const host = await signedInOperator(t, "host@venue.test");
    const { deviceId } = await t.mutation(api.devices.register, { deviceKey: KEY, utcOffsetMinutes: -420, latitude: 37.78, longitude: -122.4 });
    const shown = (await t.query(api.devices.status, { deviceId }))!;
    expect(shown.pairingCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(shown.billboardId).toBeNull();

    const billboardId = await host.mutation(api.devices.claim, {
      code: shown.pairingCode!.toLowerCase(),
      name: "Lobby screen",
      city: "San Francisco",
      locationLabel: "Moscone Center West",
      floorMinor: 5,
    });
    const screen = await t.run(async (ctx) => ctx.db.get(billboardId));
    expect(screen).toMatchObject({ deviceId, deviceStatus: "online", reserveFloorMinor: 5, latitude: 37.78, utcOffsetMinutes: -420 });
    expect(await t.query(api.devices.status, { deviceId })).toMatchObject({ pairingCode: null, billboardId });
    // The same device can't become a second screen.
    expect(await errorCode(host.mutation(api.devices.claim, { code: shown.pairingCode!, name: "Again", city: "SF", locationLabel: "x", floorMinor: 5 }))).toBe("DEVICE_TAKEN");

    vi.advanceTimersByTime(2 * 60_000);
    await t.mutation(internal.devices.markOffline, {});
    expect((await t.run(async (ctx) => ctx.db.get(billboardId)))?.deviceStatus).toBe("offline");
    await t.mutation(api.devices.heartbeat, { deviceId, deviceKey: KEY });
    expect((await t.run(async (ctx) => ctx.db.get(billboardId)))?.deviceStatus).toBe("online");
    // Only the device's own key keeps it alive.
    expect(await errorCode(t.mutation(api.devices.heartbeat, { deviceId, deviceKey: "x".repeat(64) }))).toBe("NOT_FOUND");
  });

  test("an unknown or expired code is refused", async () => {
    const t = convexTest(schema, modules);
    const host = await signedInOperator(t, "host@venue.test");
    const { deviceId } = await t.mutation(api.devices.register, { deviceKey: KEY, utcOffsetMinutes: 0 });
    const code = (await t.query(api.devices.status, { deviceId }))!.pairingCode!;
    const claim = (c: string) => host.mutation(api.devices.claim, { code: c, name: "S", city: "SF", locationLabel: "x", floorMinor: 5 });
    expect(await errorCode(claim("ZZZZZZ"))).toBe("CODE_NOT_FOUND");
    vi.advanceTimersByTime(31 * 60_000);
    expect(await errorCode(claim(code))).toBe("CODE_NOT_FOUND");
  });

  test("retireUnpaired takes simulated screens out of service and out of every list", async () => {
    const t = convexTest(schema, modules);
    const host = await signedInOperator(t, "host@venue.test");
    await host.mutation(internal.billboards.create, {
      name: "Fake screen",
      city: "SF",
      locationLabel: "x",
      utcOffsetMinutes: 0,
      baseRateMinor: 100,
      reserveFloorMinor: 50,
    });
    expect(await t.mutation(internal.devices.retireUnpaired, {})).toEqual({ retired: ["Fake screen"] });
    expect(await t.query(api.billboards.list, {})).toEqual([]);
    expect(await host.query(api.billboards.mine, {})).toEqual([]);
  });
});
