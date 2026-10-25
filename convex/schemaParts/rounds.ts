import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Rounds: one round sells the spot on air now on one screen. Every invited
 * company gets the same offer and deals with the host alone; the first deal
 * takes the spot. Spread into `schema.ts` as one line.
 */

export const roundTrigger = v.union(v.literal("camera"), v.literal("sell_now"), v.literal("timer"));
export const roundStatus = v.union(v.literal("bidding"), v.literal("awarded"), v.literal("paid"), v.literal("unsold"));
export const roundBidStatus = v.union(
  v.literal("invited"),
  v.literal("bid"),
  v.literal("passed"),
  v.literal("won"),
  v.literal("lost"),
  v.literal("defaulted"),
);
export const priceSignal = v.object({
  key: v.union(v.literal("crowd"), v.literal("event"), v.literal("demand")),
  factor: v.union(v.number(), v.null()),
  reason: v.string(),
});

export const roundFields = {
  workspaceId: v.id("workspaces"),
  billboardId: v.id("billboards"),
  slotId: v.id("slots"),
  spotStartAt: v.number(),
  spotEndAt: v.number(),
  trigger: roundTrigger,
  status: roundStatus,
  floorMinor: v.number(),
  askingMinor: v.number(),
  signals: v.array(priceSignal),
  crowd: v.union(v.number(), v.null()),
  eventName: v.union(v.string(), v.null()),
  invitedCount: v.number(),
  closesAt: v.number(),
  closedAt: v.optional(v.number()),
  winnerBidId: v.optional(v.id("roundBids")),
  runnerUpBidId: v.optional(v.id("roundBids")),
  priceMinor: v.optional(v.number()),
  holdId: v.optional(v.id("holds")),
  paymentTx: v.optional(v.string()),
  paymentNetwork: v.optional(v.string()),
  /** One sentence: what happened and why. Every round ends with one. */
  outcome: v.optional(v.string()),
  createdAt: v.number(),
};

export const roundBidFields = {
  roundId: v.id("rounds"),
  advertiserId: v.id("advertisers"),
  campaignId: v.id("campaigns"),
  agentKeyId: v.id("agentKeys"),
  /** How well the company's buyers match who is in front of the screen (null: the screen's audience isn't read yet). */
  match: v.union(v.number(), v.null()),
  /** The research agent's price factor for this company (its offer = the round's price x this). */
  companyFactor: v.optional(v.number()),
  /** The host's price to this company now: the round's asking price, or its counter. */
  offerMinor: v.optional(v.number()),
  /** The host already countered this company once; its next offer at or above the floor is a deal. */
  countered: v.optional(v.boolean()),
  /** The company's last offer (null: no answer yet, or passed). */
  amountMinor: v.union(v.number(), v.null()),
  reasoning: v.optional(v.string()),
  answeredAt: v.optional(v.number()),
  status: roundBidStatus,
};

export const roundTables = {
  rounds: defineTable(roundFields)
    .index("by_billboard_and_createdAt", ["billboardId", "createdAt"])
    .index("by_workspace_and_createdAt", ["workspaceId", "createdAt"])
    .index("by_hold", ["holdId"]),
  roundBids: defineTable(roundBidFields)
    .index("by_round", ["roundId"])
    .index("by_advertiser_and_round", ["advertiserId", "roundId"])
    .index("by_advertiser", ["advertiserId"]),
};
