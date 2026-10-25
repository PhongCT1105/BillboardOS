import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Host autopilot tables (ADR 0007 §1), spread into schema.ts.
 *
 * forwardOffers: the seller agent's standing offer for one unsold future slot,
 * at a forecast price, sent to every company agent that fits. Accepting it
 * takes a hold at that price (paid over the existing x402 purchase route).
 */

export const forwardOfferStatus = v.union(
  v.literal("open"),
  v.literal("accepted"),
  v.literal("expired"),
  v.literal("withdrawn"),
);

/** "ahead": 15 min - 2 h, forecast price decaying toward the floor. "early": 2 - 12 h, early-booking price. */
export const forwardBand = v.union(v.literal("ahead"), v.literal("early"));

export const forwardForecast = v.object({
  expectedPeople: v.number(),
  relevance: v.number(),
  /** Audience mix in front of the screen (screen tags and the event's draw). */
  tags: v.record(v.string(), v.number()),
  confidence: v.number(),
  reasoning: v.string(),
});

/** A company the offer went to, with how well it fits. */
export const forwardTarget = v.object({
  advertiserId: v.id("advertisers"),
  campaignId: v.id("campaigns"),
  agentKeyId: v.id("agentKeys"),
  company: v.string(),
  matchScore: v.number(),
  relevantViewers: v.number(),
});

/** A company that said yes during the first look (contention window). */
export const forwardInterest = v.object({
  advertiserId: v.id("advertisers"),
  campaignId: v.id("campaigns"),
  agentKeyId: v.id("agentKeys"),
  quoteId: v.id("quotes"),
  at: v.number(),
});

export const forwardOfferFields = {
  workspaceId: v.id("workspaces"),
  billboardId: v.id("billboards"),
  slotIds: v.array(v.id("slots")),
  /** Start of the (first) slot: offers are listed and expired by it. */
  slotStartAt: v.number(),
  priceMinor: v.number(),
  /** The host's published minimum; the price never goes under it. */
  floorMinor: v.number(),
  valueMinor: v.number(),
  band: forwardBand,
  forecast: forwardForecast,
  expiresAt: v.number(),
  status: forwardOfferStatus,
  acceptedBy: v.optional(
    v.object({ advertiserId: v.id("advertisers"), campaignId: v.id("campaigns"), holdId: v.id("holds"), at: v.number() }),
  ),
  /** Why it closed (withdrawn / expired), in plain words. */
  closedReason: v.optional(v.string()),
  targets: v.array(forwardTarget),
  /** Price at the last notification (re-notify when it moves enough). */
  notifiedPriceMinor: v.optional(v.number()),
  notifiedAt: v.optional(v.number()),
  /** Two or more companies were offered it: yeses until then are collected, then one hold or an auction. */
  firstLookUntil: v.optional(v.number()),
  interest: v.optional(v.array(forwardInterest)),
  /** Set when contention sent the slot to a scheduled ascending auction. */
  auctionId: v.optional(v.id("auctions")),
  /** Owner's emergency "sell this slot now". */
  override: v.optional(v.boolean()),
  updatedAt: v.number(),
};

export const autopilotLogKind = v.union(
  v.literal("offer"),
  v.literal("reprice"),
  v.literal("accepted"),
  v.literal("interest"),
  v.literal("auction"),
  v.literal("expired"),
  v.literal("withdrawn"),
  v.literal("handoff"),
  v.literal("paused"),
  v.literal("resumed"),
  v.literal("sell_now"),
  v.literal("plan"),
);

export const autopilotLogFields = {
  workspaceId: v.id("workspaces"),
  billboardId: v.optional(v.id("billboards")),
  slotId: v.optional(v.id("slots")),
  offerId: v.optional(v.id("forwardOffers")),
  kind: autopilotLogKind,
  text: v.string(),
  at: v.number(),
};

export const autopilotTables = {
  forwardOffers: defineTable(forwardOfferFields)
    .index("by_workspace_and_status", ["workspaceId", "status"])
    .index("by_billboard_and_status_and_slotStartAt", ["billboardId", "status", "slotStartAt"])
    .index("by_billboard_and_slotStartAt", ["billboardId", "slotStartAt"]),

  autopilotLog: defineTable(autopilotLogFields).index("by_workspace_and_at", ["workspaceId", "at"]),

  /** Per-workspace autopilot switch (missing row = on, ADR 0007: on by default). */
  autopilotSettings: defineTable({
    workspaceId: v.id("workspaces"),
    enabled: v.boolean(),
    changedBy: v.optional(v.string()),
    changedAt: v.optional(v.number()),
    lastPlanAt: v.optional(v.number()),
    /** Debounce for event-driven plans. */
    planRequestedAt: v.optional(v.number()),
  }).index("by_workspace", ["workspaceId"]),
};
