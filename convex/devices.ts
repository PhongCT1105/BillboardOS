import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { hashKey } from "./lib/agentKeys";
import { recordAudit } from "./lib/audit";
import { ensureUpcomingSlots } from "./lib/inventory";
import { resolveWorkspace } from "./lib/tenancy";
import { requestAudienceRead } from "./research";

/**
 * Real screens only: one device = one screen.
 *   1. A device opens #/screen. Its browser makes a random key (kept in
 *      localStorage) and registers: it gets a 6-character pairing code.
 *   2. The host types that code into "Add screen" with a name, place and
 *      floor: the device becomes that screen (claim). A device that is
 *      already a screen can't be claimed again.
 *   3. The device then plays the screen and sends a heartbeat every 20 s.
 *      Online means a heartbeat in the last 90 s (markOffline, every minute).
 */

const CODE_TTL_MS = 30 * 60_000;
const OFFLINE_AFTER_MS = 90_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_DEVICES_SWEPT = 200;

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function newCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function deviceFor(ctx: QueryCtx, deviceId: Id<"screenDevices">, deviceKey: string) {
  const device = await ctx.db.get(deviceId);
  if (!device || device.deviceKeyHash !== (await hashKey(deviceKey))) fail("NOT_FOUND", "Unknown device; register again");
  return device;
}

/** A device asks to become a screen: a new device (or one whose code ran out) gets a fresh code. */
export const register = mutation({
  args: {
    deviceId: v.optional(v.id("screenDevices")),
    deviceKey: v.string(),
    utcOffsetMinutes: v.number(),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
  },
  returns: v.object({ deviceId: v.id("screenDevices") }),
  handler: async (ctx, args) => {
    if (args.deviceKey.length < 32 || args.deviceKey.length > 128) fail("INVALID_INPUT", "deviceKey must be 32..128 characters");
    if (!Number.isInteger(args.utcOffsetMinutes) || Math.abs(args.utcOffsetMinutes) > 14 * 60) fail("INVALID_INPUT", "Bad UTC offset");
    const now = Date.now();
    const place = { latitude: args.latitude, longitude: args.longitude, utcOffsetMinutes: args.utcOffsetMinutes };
    if (args.deviceId) {
      const device = await deviceFor(ctx, args.deviceId, args.deviceKey);
      const fresh = device.billboardId || device.codeExpiresAt > now ? {} : { pairingCode: newCode(), codeExpiresAt: now + CODE_TTL_MS };
      await ctx.db.patch(device._id, { ...place, ...fresh, lastSeenAt: now });
      return { deviceId: device._id };
    }
    const deviceId = await ctx.db.insert("screenDevices", {
      deviceKeyHash: await hashKey(args.deviceKey),
      pairingCode: newCode(),
      codeExpiresAt: now + CODE_TTL_MS,
      ...place,
      lastSeenAt: now,
      createdAt: now,
    });
    return { deviceId };
  },
});

/** What the device shows: its pairing code until a host claims it, then its screen. Public by device id. */
export const status = query({
  args: { deviceId: v.id("screenDevices") },
  returns: v.union(
    v.null(),
    v.object({ pairingCode: v.union(v.string(), v.null()), codeExpiresAt: v.number(), billboardId: v.union(v.id("billboards"), v.null()) }),
  ),
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (!device) return null;
    return {
      pairingCode: device.billboardId ? null : device.pairingCode,
      codeExpiresAt: device.codeExpiresAt,
      billboardId: device.billboardId ?? null,
    };
  },
});

/** The device is running: keep its screen online. */
export const heartbeat = mutation({
  args: { deviceId: v.id("screenDevices"), deviceKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const device = await deviceFor(ctx, args.deviceId, args.deviceKey);
    await ctx.db.patch(device._id, { lastSeenAt: Date.now() });
    const screen = device.billboardId ? await ctx.db.get(device.billboardId) : null;
    if (screen && screen.deviceStatus !== "online" && screen.retiredAt === undefined) {
      await ctx.db.patch(screen._id, { deviceStatus: "online" });
      // Back online after a while: read who is here now.
      await requestAudienceRead(ctx, screen._id);
    }
    return null;
  },
});

/** The host turns a device's pairing code into a screen of their workspace. */
export const claim = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    code: v.string(),
    name: v.string(),
    city: v.string(),
    locationLabel: v.string(),
    floorMinor: v.number(),
  },
  returns: v.id("billboards"),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const name = args.name.trim();
    const city = args.city.trim();
    const locationLabel = args.locationLabel.trim();
    if ([name, city, locationLabel].some((x) => x.length === 0 || x.length > 120)) fail("INVALID_INPUT", "Name, city and place must be 1..120 characters");
    if (!Number.isSafeInteger(args.floorMinor) || args.floorMinor <= 0 || args.floorMinor > 100_000) fail("INVALID_INPUT", "Floor must be whole cents, $0.01 to $1000");
    const now = Date.now();
    const device = await ctx.db
      .query("screenDevices")
      .withIndex("by_pairingCode", (q) => q.eq("pairingCode", normalizeCode(args.code)))
      .first();
    if (!device || device.codeExpiresAt < now) fail("CODE_NOT_FOUND", "No device is showing that code (it may have expired: reload the screen)");
    if (device.billboardId) fail("DEVICE_TAKEN", "That device is already a screen");
    const taken = await ctx.db
      .query("billboards")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (taken) fail("NAME_TAKEN", "A screen with this name already exists");
    const online = now - device.lastSeenAt < OFFLINE_AFTER_MS;
    const billboardId = await ctx.db.insert("billboards", {
      workspaceId: me.workspaceId,
      name,
      city,
      locationLabel,
      utcOffsetMinutes: device.utcOffsetMinutes,
      latitude: device.latitude,
      longitude: device.longitude,
      reserveFloorMinor: args.floorMinor,
      baseRateMinor: args.floorMinor,
      deviceStatus: online ? "online" : "offline",
      deviceId: device._id,
    });
    await ctx.db.patch(device._id, { billboardId });
    const slots = await ensureUpcomingSlots(ctx, billboardId, now);
    await requestAudienceRead(ctx, billboardId);
    await recordAudit(ctx, {
      workspaceId: me.workspaceId,
      traceId: `billboard:${billboardId}`,
      actor: me.actor,
      type: "inventory.generated",
      subjectId: billboardId,
      reason: `${me.email} paired a device as screen ${name} (${locationLabel}, ${city}); ${slots} upcoming slot(s)`,
    });
    return billboardId;
  },
});

/** Every minute: a screen whose device stopped sending heartbeats goes offline (it isn't sold while off). */
export const markOffline = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - OFFLINE_AFTER_MS;
    const stale = await ctx.db
      .query("screenDevices")
      .withIndex("by_lastSeenAt", (q) => q.lt("lastSeenAt", cutoff))
      .order("desc")
      .take(MAX_DEVICES_SWEPT);
    for (const d of stale) {
      const screen = d.billboardId ? await ctx.db.get(d.billboardId) : null;
      if (screen?.deviceStatus === "online") await ctx.db.patch(screen._id, { deviceStatus: "offline" });
    }
    return null;
  },
});

/**
 * One-off: take every screen without a paired device out of service (the old
 * simulated screens). They stop selling and disappear from every list; their
 * history (bookings, invoices) stays. Run: npx convex run devices:retireUnpaired
 */
export const retireUnpaired = internalMutation({
  args: {},
  returns: v.object({ retired: v.array(v.string()) }),
  handler: async (ctx) => {
    const now = Date.now();
    const retired: string[] = [];
    for (const b of await ctx.db.query("billboards").take(500)) {
      if (b.deviceId || b.retiredAt !== undefined) continue;
      await ctx.db.patch(b._id, { retiredAt: now, deviceStatus: "offline", workspaceId: undefined });
      retired.push(b.name);
    }
    return { retired };
  },
});
