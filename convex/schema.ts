import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * BillboardOS data model (step 1: inventory, quotes, holds, payments, audit).
 *
 * Conventions:
 * - Money is an integer number of minor units (US cents). Currency is USD.
 * - Timestamps are Unix epoch milliseconds (UTC).
 * - State machines are `v.literal` unions; transitions are enforced by
 *   mutations in this directory, never by clients or agents.
 *
 * Field/validator objects are exported so `returns` validators can reuse them.
 */

// ---------------------------------------------------------------------------
// Shared literal unions
// ---------------------------------------------------------------------------

export const currency = v.literal("USD");

export const deviceStatus = v.union(v.literal("online"), v.literal("offline"));

export const slotState = v.union(
  v.literal("available"),
  v.literal("held"),
  v.literal("booked"),
  v.literal("scheduled"),
  v.literal("played"),
  v.literal("failed_delivery"),
);

export const paymentTerms = v.union(
  v.literal("prepay"),
  v.literal("net15"),
  v.literal("review"),
);

export const campaignStatus = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("completed"),
  v.literal("cancelled"),
);

export const pricingConfidence = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);

export const quoteStatus = v.union(
  v.literal("open"),
  v.literal("accepted"),
  v.literal("expired"),
);

export const holdStatus = v.union(
  v.literal("active"),
  v.literal("released"),
  v.literal("expired"),
  v.literal("converted"),
);

export const bookingStatus = v.union(
  v.literal("confirmed"),
  v.literal("scheduled"),
  v.literal("played"),
  v.literal("failed"),
);

export const paymentProvider = v.union(
  v.literal("x402"),
  v.literal("nessie"),
  v.literal("manual"),
);

export const paymentStatus = v.union(
  v.literal("verified"),
  v.literal("exception"),
  v.literal("reconciled"),
);

export const financeExceptionKind = v.union(
  v.literal("payment_after_hold_expired"),
  v.literal("amount_mismatch"),
  v.literal("asset_mismatch"),
  v.literal("duplicate_payment"),
);

export const financeExceptionStatus = v.union(
  v.literal("open"),
  v.literal("resolved"),
);

export const audienceSource = v.union(
  v.literal("camera"),
  v.literal("simulated"),
);

/** Every event type the audit log accepts. Agent event types from docs/architecture/data-model.md are included up front. */
export const auditEventType = v.union(
  // inventory / booking lifecycle
  v.literal("seed.completed"),
  v.literal("quote.created"),
  v.literal("quote.expired"),
  v.literal("slot.held"),
  v.literal("slot.released"),
  v.literal("hold.released"),
  v.literal("hold.expired"),
  v.literal("payment.confirmed"),
  v.literal("payment.replayed"),
  v.literal("payment.exception"),
  v.literal("booking.confirmed"),
  v.literal("finance.exception_opened"),
  // agent / operator events (used by later steps)
  v.literal("brief.parsed"),
  v.literal("inventory.queried"),
  v.literal("quote.proposed"),
  v.literal("counteroffer.received"),
  v.literal("policy.evaluated"),
  v.literal("payment.verification_requested"),
  v.literal("creative.approved"),
  v.literal("playback.observed"),
  v.literal("operator.approved"),
);

/** Small structured payload for audit events: primitives or string lists (e.g. slot ids). */
export const auditData = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean(), v.null(), v.array(v.string())),
);

// ---------------------------------------------------------------------------
// Table field definitions
// ---------------------------------------------------------------------------

export const billboardFields = {
  name: v.string(),
  city: v.string(),
  locationLabel: v.string(),
  /** Fixed UTC offset used for hour-of-day pricing (e.g. -420 for PDT). */
  utcOffsetMinutes: v.number(),
  /** Operator floor per slot; price never goes below this. */
  reserveFloorMinor: v.number(),
  /** Baseline price per slot before demand / hour-of-day adjustment. */
  baseRateMinor: v.number(),
  deviceStatus,
};

export const slotFields = {
  billboardId: v.id("billboards"),
  startAt: v.number(),
  endAt: v.number(),
  state: slotState,
  holdId: v.optional(v.id("holds")),
  bookingId: v.optional(v.id("bookings")),
};

export const advertiserFields = {
  displayName: v.string(),
  paymentTerms,
};

export const campaignFields = {
  advertiserId: v.id("advertisers"),
  brief: v.string(),
  targetCity: v.optional(v.string()),
  budgetMinor: v.number(),
  currency,
  status: campaignStatus,
};

export const quoteFields = {
  campaignId: v.id("campaigns"),
  /** All slots in a quote belong to one billboard (multi-screen bundles are P2). */
  billboardId: v.id("billboards"),
  slotIds: v.array(v.id("slots")),
  amountMinor: v.number(),
  currency,
  expiresAt: v.number(),
  pricingBasis: v.array(v.string()),
  confidence: pricingConfidence,
  /** Audience aggregate the price was derived from (provenance), if any. */
  audienceAggregateId: v.optional(v.id("audienceAggregates")),
  policyVersion: v.string(),
  status: quoteStatus,
  /** Correlates every audit event in this quote -> hold -> payment -> booking chain. */
  traceId: v.string(),
};

export const holdFields = {
  quoteId: v.id("quotes"),
  billboardId: v.id("billboards"),
  slotIds: v.array(v.id("slots")),
  /** Copied from the quote; the only amount a payment can match. */
  amountMinor: v.number(),
  currency,
  expiresAt: v.number(),
  status: holdStatus,
  idempotencyKey: v.string(),
  actor: v.string(),
  traceId: v.string(),
};

export const bookingFields = {
  holdId: v.id("holds"),
  quoteId: v.id("quotes"),
  billboardId: v.id("billboards"),
  slotIds: v.array(v.id("slots")),
  amountMinor: v.number(),
  currency,
  paymentId: v.id("payments"),
  status: bookingStatus,
  traceId: v.string(),
};

export const paymentFields = {
  holdId: v.id("holds"),
  provider: paymentProvider,
  externalRef: v.string(),
  /** Observed amount in USD cents (the reporting server converts asset units). */
  amountMinor: v.number(),
  asset: v.string(),
  network: v.optional(v.string()),
  status: paymentStatus,
  idempotencyKey: v.string(),
  /** Outcome pointers so a replay can return the original result. */
  bookingId: v.optional(v.id("bookings")),
  financeExceptionId: v.optional(v.id("financeExceptions")),
};

export const financeExceptionFields = {
  kind: financeExceptionKind,
  status: financeExceptionStatus,
  holdId: v.id("holds"),
  billboardId: v.id("billboards"),
  paymentId: v.optional(v.id("payments")),
  expectedMinor: v.number(),
  observedMinor: v.number(),
  evidence: v.string(),
  nextAction: v.string(),
};

export const audienceAggregateFields = {
  billboardId: v.id("billboards"),
  bucketStart: v.number(),
  countEstimate: v.number(),
  source: audienceSource,
  /** 0..1 */
  confidence: v.number(),
};

export const auditEventFields = {
  traceId: v.string(),
  /** e.g. "system", "operator", "agent:pricing", "buyer:<name>" */
  actor: v.string(),
  type: auditEventType,
  subjectId: v.string(),
  reason: v.string(),
  data: v.optional(auditData),
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export default defineSchema({
  billboards: defineTable(billboardFields).index("by_name", ["name"]),

  slots: defineTable(slotFields).index("by_billboard_and_startAt", [
    "billboardId",
    "startAt",
  ]),

  advertisers: defineTable(advertiserFields).index("by_displayName", [
    "displayName",
  ]),

  campaigns: defineTable(campaignFields).index("by_advertiser", [
    "advertiserId",
  ]),

  quotes: defineTable(quoteFields).index("by_campaign", ["campaignId"]),

  holds: defineTable(holdFields)
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_quote_and_status", ["quoteId", "status"]),

  bookings: defineTable(bookingFields)
    .index("by_hold", ["holdId"])
    .index("by_billboard", ["billboardId"]),

  payments: defineTable(paymentFields)
    .index("by_externalRef", ["externalRef"])
    .index("by_hold", ["holdId"]),

  financeExceptions: defineTable(financeExceptionFields)
    .index("by_status", ["status"])
    .index("by_billboard_and_status", ["billboardId", "status"]),

  audienceAggregates: defineTable(audienceAggregateFields).index(
    "by_billboard_and_bucketStart",
    ["billboardId", "bucketStart"],
  ),

  auditEvents: defineTable(auditEventFields)
    .index("by_trace", ["traceId"])
    .index("by_subject", ["subjectId"]),
});
