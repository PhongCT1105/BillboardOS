import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Selling the spot on air: real screen devices (one device = one screen,
 * paired with a code) and what the research agent learned about each
 * company. Spread into `schema.ts` as one line.
 */

export const researchMethod = v.union(v.literal("claude"), v.literal("rules"));

export const screenDeviceFields = {
  /** SHA-256 of the device's own random key (kept in the device's browser). */
  deviceKeyHash: v.string(),
  /** Shown on the device until a host claims it. */
  pairingCode: v.string(),
  codeExpiresAt: v.number(),
  /** The screen this device became (set once, when a host claims the code). */
  billboardId: v.optional(v.id("billboards")),
  /** Where the browser says it is, if it allowed geolocation. */
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  utcOffsetMinutes: v.number(),
  lastSeenAt: v.number(),
  createdAt: v.number(),
};

export const companyResearchFields = {
  advertiserId: v.id("advertisers"),
  summary: v.string(),
  category: v.string(),
  /** Who buys from this company (shares over the shared segment keys, ~sum 1): drives matching. */
  audienceTags: v.record(v.string(), v.number()),
  /** How much the right crowd is worth to this company vs an average advertiser (x0.8-x1.5): its own price. */
  priceFactor: v.number(),
  reasoning: v.string(),
  sources: v.array(v.string()),
  method: researchMethod,
  researchedAt: v.number(),
};

export const salesTables = {
  screenDevices: defineTable(screenDeviceFields)
    .index("by_pairingCode", ["pairingCode"])
    .index("by_billboard", ["billboardId"])
    .index("by_lastSeenAt", ["lastSeenAt"]),
  companyResearch: defineTable(companyResearchFields).index("by_advertiser", ["advertiserId"]),
};
