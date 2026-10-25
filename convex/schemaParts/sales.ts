import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Selling the spot on air: real screen devices (one device = one screen,
 * paired with a code) and what the research agent learned about each
 * company. Spread into `schema.ts` as one line.
 */

export const researchMethod = v.union(v.literal("claude"), v.literal("creao"), v.literal("rules"));

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
  /** The device's camera (CNN person detector): people in view now, and when it last counted. */
  peopleNow: v.optional(v.number()),
  peopleAt: v.optional(v.number()),
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

/** One closed window: what it sold for (null: unsold). The price model trains on these. */
export const priceWindowFields = {
  billboardId: v.id("billboards"),
  at: v.number(),
  utcOffsetMinutes: v.number(),
  people: v.union(v.number(), v.null()),
  winnerMinor: v.union(v.number(), v.null()),
  source: v.union(v.literal("live"), v.literal("sim")),
};

/** A trained price model (ridge regression over FEATURES in lib/priceModel.ts). */
export const priceModelFields = {
  features: v.array(v.string()),
  coef: v.array(v.number()),
  samples: v.number(),
  liveSamples: v.number(),
  rmseMinor: v.number(),
  trainedAt: v.number(),
};

export const salesTables = {
  priceWindows: defineTable(priceWindowFields).index("by_billboard_and_at", ["billboardId", "at"]),
  priceModels: defineTable(priceModelFields).index("by_trainedAt", ["trainedAt"]),
  screenDevices: defineTable(screenDeviceFields)
    .index("by_pairingCode", ["pairingCode"])
    .index("by_billboard", ["billboardId"])
    .index("by_lastSeenAt", ["lastSeenAt"]),
  companyResearch: defineTable(companyResearchFields).index("by_advertiser", ["advertiserId"]),
};
