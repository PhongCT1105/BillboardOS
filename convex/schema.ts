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

export const creativeStatus = v.union(
  v.literal("none"),
  v.literal("pending_review"),
  v.literal("approved"),
  v.literal("rejected"),
);

export const playbackStatus = v.union(v.literal("played"), v.literal("failed"));

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
  /** Refund approved by the controller and recorded (money movement is out of scope). */
  v.literal("refunded"),
);

export const financeExceptionKind = v.union(
  v.literal("payment_after_hold_expired"),
  v.literal("amount_mismatch"),
  v.literal("asset_mismatch"),
  v.literal("duplicate_payment"),
  // Accounts receivable (bank feed reconciliation)
  v.literal("short_payment"),
  v.literal("overpayment"),
  v.literal("unidentified_payment"),
);

export const financeExceptionStatus = v.union(
  v.literal("open"),
  v.literal("resolved"),
);

export const invoiceStatus = v.union(
  v.literal("open"),
  v.literal("partially_paid"),
  v.literal("paid"),
  v.literal("disputed"),
  v.literal("written_off"),
);

/** "fixture" = simulated/seeded data; the UI must label it as such. */
export const dataSource = v.union(v.literal("booking"), v.literal("fixture"));

export const bankSource = v.union(v.literal("nessie"), v.literal("fixture"));

export const bankTransactionStatus = v.union(
  v.literal("unmatched"),
  v.literal("matched"),
  v.literal("partially_applied"),
  v.literal("needs_review"),
);

export const reconcileRule = v.union(
  v.literal("invoice_number"),
  v.literal("bundled_invoices"),
  v.literal("payer_exact_amount"),
  v.literal("payer_bundle_exact"),
  v.literal("payer_open_balance"),
  v.literal("duplicate_line"),
  v.literal("unidentified"),
  v.literal("no_open_invoices"),
  v.literal("manual_match"),
);

export const approvalAction = v.union(
  v.literal("write_off"),
  v.literal("refund"),
  v.literal("apply_manual_match"),
  v.literal("escalate_collection"),
);

export const approvalSubjectKind = v.union(
  v.literal("invoice"),
  v.literal("payment"),
  v.literal("bank_transaction"),
);

export const approvalStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
);

export const collectionTone = v.union(
  v.literal("friendly"),
  v.literal("firm"),
  v.literal("escalate_to_controller"),
);

export const collectionTaskStatus = v.union(
  v.literal("planned"),
  v.literal("sent"),
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
  v.literal("demo.reset"),
  v.literal("inventory.generated"),
  v.literal("billboard.baseline_changed"),
  v.literal("campaign.created"),
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
  v.literal("booking.scheduled"),
  v.literal("finance.exception_opened"),
  v.literal("finance.exception_resolved"),
  // accounts receivable / controls
  v.literal("invoice.issued"),
  v.literal("invoice.paid"),
  v.literal("invoice.written_off"),
  v.literal("bank.ingested"),
  v.literal("bank.duplicate_ignored"),
  v.literal("reconciliation.applied"),
  v.literal("reconciliation.needs_review"),
  v.literal("reconciliation.handoff"),
  v.literal("approval.requested"),
  v.literal("approval.approved"),
  v.literal("approval.rejected"),
  v.literal("approval.executed"),
  v.literal("refund.recorded"),
  v.literal("collection.planned"),
  v.literal("collection.resolved"),
  // agent / operator events (used by later steps)
  v.literal("brief.parsed"),
  v.literal("inventory.queried"),
  v.literal("quote.proposed"),
  v.literal("counteroffer.received"),
  v.literal("policy.evaluated"),
  v.literal("payment.verification_requested"),
  v.literal("creative.attached"),
  v.literal("creative.approved"),
  v.literal("creative.rejected"),
  v.literal("playback.observed"),
  v.literal("playback.failed"),
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
  /** "Normal traffic" in people per 15 min for demand pricing; missing = 120. */
  audienceBaselinePerBucket: v.optional(v.number()),
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
  /** Names this advertiser appears under on bank statements (matching evidence). */
  payerAliases: v.optional(v.array(v.string())),
};

export const campaignFields = {
  advertiserId: v.id("advertisers"),
  brief: v.string(),
  targetCity: v.optional(v.string()),
  budgetMinor: v.number(),
  currency,
  status: campaignStatus,
  /** Missing on legacy rows = "none". */
  creativeStatus: v.optional(creativeStatus),
  /** Storage id of the creative; URLs are resolved on read, never stored. */
  creativeStorageId: v.optional(v.id("_storage")),
  creativeContentType: v.optional(v.string()),
  creativeSubmittedAt: v.optional(v.number()),
  creativeReviewReason: v.optional(v.string()),
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
  campaignId: v.id("campaigns"),
  billboardId: v.id("billboards"),
  slotIds: v.array(v.id("slots")),
  amountMinor: v.number(),
  currency,
  /** Set when paid up front (x402 / manual). */
  paymentId: v.optional(v.id("payments")),
  /** Set when booked on terms (net15) against an invoice. */
  invoiceId: v.optional(v.id("invoices")),
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
  /** Booking-side exceptions (x402/manual) have a hold + billboard. */
  holdId: v.optional(v.id("holds")),
  billboardId: v.optional(v.id("billboards")),
  paymentId: v.optional(v.id("payments")),
  /** AR-side exceptions (bank feed) point at the bank line / invoice / payer. */
  bankTransactionId: v.optional(v.id("bankTransactions")),
  invoiceId: v.optional(v.id("invoices")),
  advertiserId: v.optional(v.id("advertisers")),
  expectedMinor: v.number(),
  observedMinor: v.number(),
  evidence: v.string(),
  nextAction: v.string(),
  /** Set only by executing a controller-approved approval. */
  resolution: v.optional(v.string()),
  resolvedBy: v.optional(v.string()),
  resolvedAt: v.optional(v.number()),
};

export const audienceAggregateFields = {
  billboardId: v.id("billboards"),
  bucketStart: v.number(),
  countEstimate: v.number(),
  source: audienceSource,
  /** 0..1 */
  confidence: v.number(),
  /** Max people simultaneously in view during the bucket (dwell proxy). */
  peakInView: v.optional(v.number()),
};

export const playbackEventFields = {
  bookingId: v.id("bookings"),
  slotId: v.id("slots"),
  billboardId: v.id("billboards"),
  campaignId: v.id("campaigns"),
  /** Creative that was on screen; absent if the campaign had none (failed delivery). */
  storageId: v.optional(v.id("_storage")),
  contentType: v.optional(v.string()),
  observedAt: v.number(),
  status: playbackStatus,
};

export const invoiceFields = {
  /** Human-readable, unique: "INV-1042". */
  number: v.string(),
  advertiserId: v.id("advertisers"),
  campaignId: v.optional(v.id("campaigns")),
  bookingId: v.optional(v.id("bookings")),
  description: v.string(),
  amountMinor: v.number(),
  currency,
  issuedAt: v.number(),
  dueAt: v.number(),
  status: invoiceStatus,
  /** Cash applied from bank lines / payments. */
  paidMinor: v.number(),
  /** Sub-materiality differences accepted by policy (never above the threshold). */
  adjustmentMinor: v.number(),
  /** Controller-approved write-offs. */
  writtenOffMinor: v.number(),
  /** When the balance reached zero by payment (drives late-payment history). */
  paidAt: v.optional(v.number()),
  source: dataSource,
};

export const bankTransactionFields = {
  source: bankSource,
  /** Unique per source; re-delivered lines are dropped at ingest. */
  externalId: v.string(),
  amountMinor: v.number(),
  postedAt: v.number(),
  payerName: v.string(),
  memo: v.string(),
  status: bankTransactionStatus,
  appliedMinor: v.number(),
  /** Overpayment amount refunded after controller approval. */
  refundedMinor: v.optional(v.number()),
  advertiserId: v.optional(v.id("advertisers")),
  rule: v.optional(reconcileRule),
  note: v.optional(v.string()),
  duplicateOf: v.optional(v.id("bankTransactions")),
};

export const paymentApplicationFields = {
  invoiceId: v.id("invoices"),
  bankTransactionId: v.id("bankTransactions"),
  amountMinor: v.number(),
  /** "agent:ar" for automatic matches; "<requester> (approved by <approver>)" for manual. */
  appliedBy: v.string(),
  rule: reconcileRule,
  evidence: v.string(),
};

export const approvalFields = {
  action: approvalAction,
  subjectKind: approvalSubjectKind,
  subjectId: v.string(),
  /** Target invoice for apply_manual_match. */
  invoiceId: v.optional(v.id("invoices")),
  financeExceptionId: v.optional(v.id("financeExceptions")),
  collectionTaskId: v.optional(v.id("collectionTasks")),
  amountMinor: v.number(),
  requestedBy: v.string(),
  reason: v.string(),
  status: approvalStatus,
  decidedBy: v.optional(v.string()),
  decidedAt: v.optional(v.number()),
  decisionNote: v.optional(v.string()),
  executionResult: v.optional(v.string()),
};

export const collectionTaskFields = {
  invoiceId: v.id("invoices"),
  advertiserId: v.id("advertisers"),
  tone: collectionTone,
  /** Cites the payer's history (the "Time" dimension). */
  reason: v.string(),
  status: collectionTaskStatus,
  daysOverdue: v.number(),
  balanceMinor: v.number(),
  plannedAt: v.number(),
  approvalId: v.optional(v.id("approvals")),
  /** Hook for later outreach (CREAO / LLM draft). Nothing is sent in this step. */
  draft: v.optional(v.string()),
  resolution: v.optional(v.string()),
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

  campaigns: defineTable(campaignFields)
    .index("by_advertiser", ["advertiserId"])
    .index("by_creativeStatus", ["creativeStatus"]),

  quotes: defineTable(quoteFields).index("by_campaign", ["campaignId"]),

  holds: defineTable(holdFields)
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_quote_and_status", ["quoteId", "status"])
    .index("by_billboard_and_status", ["billboardId", "status"]),

  bookings: defineTable(bookingFields)
    .index("by_hold", ["holdId"])
    .index("by_billboard", ["billboardId"])
    .index("by_campaign_and_status", ["campaignId", "status"]),

  payments: defineTable(paymentFields)
    .index("by_externalRef", ["externalRef"])
    .index("by_hold", ["holdId"]),

  financeExceptions: defineTable(financeExceptionFields)
    .index("by_status", ["status"])
    .index("by_billboard_and_status", ["billboardId", "status"])
    .index("by_bankTransaction", ["bankTransactionId"]),

  audienceAggregates: defineTable(audienceAggregateFields).index(
    "by_billboard_and_bucketStart",
    ["billboardId", "bucketStart"],
  ),

  invoices: defineTable(invoiceFields)
    .index("by_number", ["number"])
    .index("by_advertiser", ["advertiserId"])
    .index("by_advertiser_and_status", ["advertiserId", "status"])
    .index("by_status_and_dueAt", ["status", "dueAt"]),

  bankTransactions: defineTable(bankTransactionFields)
    .index("by_source_and_externalId", ["source", "externalId"])
    .index("by_status_and_postedAt", ["status", "postedAt"])
    .index("by_postedAt", ["postedAt"]),

  paymentApplications: defineTable(paymentApplicationFields)
    .index("by_invoice", ["invoiceId"])
    .index("by_bankTransaction", ["bankTransactionId"]),

  approvals: defineTable(approvalFields)
    .index("by_status", ["status"])
    .index("by_financeException", ["financeExceptionId"])
    .index("by_subject", ["subjectId"]),

  collectionTasks: defineTable(collectionTaskFields)
    .index("by_invoice", ["invoiceId"])
    .index("by_status", ["status"]),

  /** Monotonic counters (invoice numbers). */
  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),

  playbackEvents: defineTable(playbackEventFields)
    .index("by_slot_and_status", ["slotId", "status"])
    .index("by_billboard", ["billboardId"]),

  auditEvents: defineTable(auditEventFields)
    .index("by_trace", ["traceId"])
    .index("by_subject", ["subjectId"]),
});
