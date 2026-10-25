import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Rounds: one round sells the next 30-second window on one screen while the
 * current one plays. Every invited company gets its own price and two turns;
 * the highest agreed price wins at the end. Spread into `schema.ts` as one line.
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
  /** Legacy (15-minute slots); windows aren't slots. */
  slotId: v.optional(v.id("slots")),
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
  /** How the window was priced: price = a x predicted + b x people + c x brand (per company), clamped to [floor, cap]. */
  pricing: v.optional(
    v.object({
      predictedMinor: v.number(),
      modelId: v.union(v.id("priceModels"), v.null()),
      people: v.union(v.number(), v.null()),
      a: v.number(),
      b: v.number(),
      c: v.number(),
      capMultiplier: v.number(),
    }),
  ),
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
  /** The research agent's price factor for this company (legacy rounds: offer = price x this). */
  companyFactor: v.optional(v.number()),
  /** Brand value 0..1 (from research) and how this company's price was built. */
  brand: v.optional(v.number()),
  priceTerms: v.optional(
    v.object({
      modelMinor: v.number(),
      peopleMinor: v.number(),
      brandMinor: v.number(),
      capMinor: v.number(),
      capped: v.union(v.literal("floor"), v.literal("cap"), v.null()),
    }),
  ),
  /** When this company agreed a price (status "bid"); ties at the close go to the earlier. */
  agreedAt: v.optional(v.number()),
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

/** Every move in a negotiation, in order: the training data and the live graph. */
export const negotiationStepFields = {
  roundId: v.id("rounds"),
  billboardId: v.id("billboards"),
  advertiserId: v.id("advertisers"),
  actor: v.union(v.literal("host"), v.literal("company")),
  kind: v.union(v.literal("offer"), v.literal("counter"), v.literal("accept"), v.literal("pass")),
  amountMinor: v.union(v.number(), v.null()),
  reasoning: v.optional(v.string()),
  at: v.number(),
};

/** Per billboard × advertiser: price-reject streaks and cool-downs for invite rotation. */
export const inviteStatFields = {
  billboardId: v.id("billboards"),
  advertiserId: v.id("advertisers"),
  rejectStreak: v.number(),
  cooledUntilAt: v.optional(v.number()),
  lastOutcome: v.union(v.literal("agreed"), v.literal("reject")),
  updatedAt: v.number(),
};

/** Optional Invite CREAO preference weights (secondary sort after vibe match). */
export const billboardInvitePrefFields = {
  billboardId: v.id("billboards"),
  advertiserId: v.id("advertisers"),
  weight: v.number(),
  reason: v.string(),
  updatedAt: v.number(),
};

/** Last background harness runs (Price / Invite CREAO), one row per kind × billboard-or-global. */
export const harnessRunFields = {
  kind: v.union(v.literal("price"), v.literal("invite")),
  /** Null = workspace-wide / global price sweep. */
  billboardId: v.optional(v.id("billboards")),
  workspaceId: v.optional(v.id("workspaces")),
  status: v.union(v.literal("ok"), v.literal("skipped"), v.literal("failed")),
  summary: v.string(),
  at: v.number(),
};

export const roundTables = {
  negotiationSteps: defineTable(negotiationStepFields).index("by_round", ["roundId"]),
  rounds: defineTable(roundFields)
    .index("by_billboard_and_createdAt", ["billboardId", "createdAt"])
    .index("by_workspace_and_createdAt", ["workspaceId", "createdAt"])
    .index("by_hold", ["holdId"]),
  roundBids: defineTable(roundBidFields)
    .index("by_round", ["roundId"])
    .index("by_advertiser_and_round", ["advertiserId", "roundId"])
    .index("by_advertiser", ["advertiserId"]),
  inviteStats: defineTable(inviteStatFields)
    .index("by_billboard_and_advertiser", ["billboardId", "advertiserId"])
    .index("by_billboard", ["billboardId"]),
  billboardInvitePrefs: defineTable(billboardInvitePrefFields)
    .index("by_billboard_and_advertiser", ["billboardId", "advertiserId"])
    .index("by_billboard", ["billboardId"]),
  harnessRuns: defineTable(harnessRunFields)
    .index("by_kind_and_at", ["kind", "at"])
    .index("by_billboard_and_kind", ["billboardId", "kind"]),
};
