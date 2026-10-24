import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
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
  /** Legacy: kept so old rows validate; no new code writes it. */
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
  // Auctions
  v.literal("winner_default"),
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

export const brandTier = v.union(
  v.literal("enterprise"),
  v.literal("established"),
  v.literal("growth"),
  v.literal("startup"),
  v.literal("unknown"),
);

export const valuationMethod = v.union(v.literal("claude"), v.literal("heuristic"), v.literal("override"));

export const stageKey = v.union(
  v.literal("crowd"),
  v.literal("time"),
  v.literal("event"),
  v.literal("scarcity"),
  v.literal("market"),
);

/** A pricing stage as applied to one slot (see lib/pricing.ts). */
export const appliedStage = v.object({
  key: stageKey,
  multiplier: v.number(),
  confidence: v.number(),
  /** 1 + (multiplier - 1) x confidence, as used by the combiner. */
  effective: v.number(),
  explanation: v.string(),
});

/** Per-slot screen-price breakdown stored on a quote. */
export const slotPriceBreakdown = v.object({
  slotId: v.id("slots"),
  slotStartAt: v.number(),
  computedMinor: v.number(),
  /** Screen price after floor/ceiling (before any company adjustment). */
  screenMinor: v.number(),
  floorApplied: v.boolean(),
  ceilingApplied: v.boolean(),
  stages: v.array(appliedStage),
});

/** Audience mix weights, e.g. { software: 0.6, startups: 0.2, tourists: 0.2 }. */
export const audienceTags = v.record(v.string(), v.number());

export const audienceSource = v.union(
  v.literal("camera"),
  /** Legacy: kept so old rows validate; no new code writes it. */
  v.literal("simulated"),
);

/** Every event type the audit log accepts. Agent event types from docs/architecture/data-model.md are included up front. */
export const auditEventType = v.union(
  // inventory / booking lifecycle
  v.literal("seed.completed"),
  v.literal("workspace.created"),
  v.literal("workspace.member_added"),
  v.literal("workspace.payout_changed"),
  v.literal("company.created"),
  v.literal("agent_key.created"),
  v.literal("watch_rule.changed"),
  v.literal("agent_key.revoked"),
  v.literal("tenancy.migrated"),
  v.literal("operator.granted"),
  v.literal("demo.reset"),
  v.literal("inventory.generated"),
  v.literal("billboard.baseline_changed"),
  v.literal("billboard.audience_tags_changed"),
  v.literal("event.recorded"),
  v.literal("valuation.assessed"),
  v.literal("valuation.overridden"),
  v.literal("valuation.failed"),
  v.literal("auction.opened"),
  v.literal("auction.joined"),
  v.literal("auction.bid"),
  v.literal("auction.auto_bid_set"),
  v.literal("auction.extended"),
  v.literal("auction.closed"),
  v.literal("auction.failed"),
  v.literal("auction.winner_default"),
  v.literal("auction.runner_up_offered"),
  v.literal("auction.settled"),
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
  // agent-to-agent commerce (ADR 0005)
  v.literal("negotiation.opened"),
  v.literal("negotiation.message"),
  v.literal("negotiation.agreed"),
  v.literal("negotiation.closed"),
  v.literal("workspace.policy_changed"),
  v.literal("data_sale.recorded"),
  v.literal("moment.detected"),
  v.literal("moment.offer"),
  v.literal("moment.reply"),
  v.literal("moment.awarded"),
  v.literal("moment.paid"),
  v.literal("moment.closed"),
  v.literal("creative.ready"),
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
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Max price per slot; missing = 4x base rate. */
  priceCeilingMinor: v.optional(v.number()),
  /** Who is likely in front of this screen (shares, ~sum 1). Used for matching, not price. */
  audienceTags: v.optional(audienceTags),
  /** Host's CPM in minor units, the basis for the live value price. */
  cpmMinor: v.optional(v.number()),
  /** When the host queued this screen for a live sale. */
  saleQueuedAt: v.optional(v.number()),
  /** When this screen's pending re-offer (detectFor "reoffer") is due: one re-offer chain per screen. */
  reofferDueAt: v.optional(v.number()),
};

export const slotFields = {
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
  billboardId: v.id("billboards"),
  startAt: v.number(),
  endAt: v.number(),
  state: slotState,
  holdId: v.optional(v.id("holds")),
  bookingId: v.optional(v.id("bookings")),
  /** Latest auction for this slot; while that auction is open the slot can't be sold at a posted price. */
  auctionId: v.optional(v.id("auctions")),
};

export const companySize = v.union(
  v.literal("1-10"),
  v.literal("11-50"),
  v.literal("51-200"),
  v.literal("201-1000"),
  v.literal("1000+"),
);

/** Customer company (ADR 0004). Seeded companies have no owner or members yet. */
export const advertiserFields = {
  displayName: v.string(),
  paymentTerms,
  ownerUserId: v.optional(v.id("users")),
  website: v.optional(v.string()),
  size: v.optional(companySize),
  /** Last time a company valuation was scheduled (debounces refreshes). */
  valuationRequestedAt: v.optional(v.number()),
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
  /** Who the campaign wants to reach (weights). Used for screen matching and bidding. */
  targetAudience: v.optional(audienceTags),
};

export const quoteFields = {
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Set when an agent key created this quote. */
  agentKeyId: v.optional(v.id("agentKeys")),
  /** Structured screen-price stages per slot (buyer-visible explanation). */
  priceBreakdown: v.optional(v.array(slotPriceBreakdown)),
  /** Sum of screen prices before company valuation (operator-only). */
  screenAmountMinor: v.optional(v.number()),
  /** Company valuation applied to this posted quote (operator-only, never shown to the buyer). */
  companyMultiplier: v.optional(v.number()),
  companyAssessmentId: v.optional(v.id("companyAssessments")),
  companyMethod: v.optional(v.union(valuationMethod, v.literal("inline_heuristic"))),
};

export const holdFields = {
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Set when this hold was granted to an auction winner (or runner-up). */
  auctionId: v.optional(v.id("auctions")),
  /** Set when an agent key took this hold (counts against the key's budget cap). */
  agentKeyId: v.optional(v.id("agentKeys")),
};

export const bookingFields = {
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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

export const eventSource = v.union(v.literal("seed"), v.literal("operator"), v.literal("claude"));

export const eventFields = {
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
  billboardId: v.id("billboards"),
  name: v.string(),
  startsAt: v.number(),
  endsAt: v.number(),
  expectedAttendance: v.optional(v.number()),
  audienceTags: v.optional(audienceTags),
  /** Price uplift while the event is on (clamped to x1.0..x1.5 by the event stage). */
  upliftMultiplier: v.number(),
  /** 0..1 */
  confidence: v.number(),
  source: eventSource,
  explanation: v.string(),
};

export const saleKind = v.union(v.literal("posted"), v.literal("terms"), v.literal("auction"));

/** One row per sold slot: the market-history stage's evidence. */
export const priceHistoryFields = {
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
  billboardId: v.id("billboards"),
  slotId: v.id("slots"),
  slotStartAt: v.number(),
  /** Local hour band, e.g. "evening" (see lib/pricing.ts hourBand). */
  hourBand: v.string(),
  unitPriceMinor: v.number(),
  /** unitPrice / (base x hour factor): how the sale compared to a plain time-adjusted base. */
  normalizedRatio: v.number(),
  kind: saleKind,
  recordedAt: v.number(),
};

/** Company willingness-to-pay assessment (ADR 0003 section 2). Operator-only data. */
export const companyAssessmentFields = {
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
  advertiserId: v.id("advertisers"),
  /** Clamped to x0.75..x1.5 in code before storage. */
  multiplier: v.number(),
  brandTier,
  reasoning: v.string(),
  /** URLs the analyst cited (web search results). */
  sources: v.array(v.string()),
  /** 0..1 */
  confidence: v.number(),
  method: valuationMethod,
  model: v.optional(v.string()),
  /** Compact, company-level summary of what the analyst saw (no personal data). */
  inputsSummary: v.string(),
  assessedAt: v.number(),
  expiresAt: v.number(),
  /** Who set an override ("operator:<email>"). */
  overriddenBy: v.optional(v.string()),
};

export const auctionStatus = v.union(
  v.literal("open"),
  v.literal("closed"),
  v.literal("settled"),
  v.literal("failed"),
);

/** Ascending auction with proxy bidding and soft close (ADR 0003 section 3). */
export const auctionFields = {
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
  billboardId: v.id("billboards"),
  slotIds: v.array(v.id("slots")),
  /** Screen price from the harness at open; every bidder faces the same reserve. */
  reserveMinor: v.number(),
  /** Current price: the leader's visible bid (reserve while nobody leads). */
  currentMinor: v.number(),
  leaderParticipantId: v.optional(v.id("auctionParticipants")),
  status: auctionStatus,
  openedAt: v.number(),
  endsAt: v.number(),
  /** Soft-close extensions never go past this. */
  hardEndsAt: v.number(),
  incrementRule: v.object({ percentBps: v.number(), minMinor: v.number() }),
  softCloseMs: v.number(),
  openedBy: v.string(),
  openReason: v.string(),
  traceId: v.string(),
  extensions: v.number(),
  closedAt: v.optional(v.number()),
  /** Participant currently entitled to buy (winner, or runner-up after a default). */
  winnerParticipantId: v.optional(v.id("auctionParticipants")),
  winningBidMinor: v.optional(v.number()),
  winnerHoldId: v.optional(v.id("holds")),
  defaultedParticipantIds: v.optional(v.array(v.id("auctionParticipants"))),
  outcomeNote: v.optional(v.string()),
};

/** A campaign registered to bid. The bidder key is stored hashed; labels are anonymized. */
export const auctionParticipantFields = {
  auctionId: v.id("auctions"),
  campaignId: v.id("campaigns"),
  /** "Bidder A", "Bidder B", ... in join order. */
  label: v.string(),
  keyHash: v.string(),
  /** Highest manual bid. */
  manualTopMinor: v.number(),
  /** max(manual top, auto-bid max), capped by budget. PRIVATE. */
  effectiveMaxMinor: v.number(),
  /** When effectiveMax last increased (earliest wins ties). */
  maxSetAt: v.number(),
  /** Hold key granted if this participant wins (returned only via myStatus). */
  holdKey: v.optional(v.string()),
  /** Set when an agent key joined (its leading bid counts against the key's budget cap). */
  agentKeyId: v.optional(v.id("agentKeys")),
};

export const bidFields = {
  auctionId: v.id("auctions"),
  campaignId: v.id("campaigns"),
  participantId: v.id("auctionParticipants"),
  bidderLabel: v.string(),
  amountMinor: v.number(),
  isAuto: v.boolean(),
  createdAt: v.number(),
};

/** Private proxy maximum per campaign per auction. Never returned by public queries. */
export const autoBidFields = {
  auctionId: v.id("auctions"),
  campaignId: v.id("campaigns"),
  participantId: v.id("auctionParticipants"),
  maxMinor: v.number(),
  updatedAt: v.number(),
};

export const auditEventFields = {
  /** Owning host workspace (ADR 0004). Optional until backfilled. */
  workspaceId: v.optional(v.id("workspaces")),
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

export const agentScope = v.union(v.literal("quote"), v.literal("hold"), v.literal("bid"), v.literal("pay"));

// ---------------------------------------------------------------------------
// Agent-to-agent negotiation and data sales (ADR 0005)
// ---------------------------------------------------------------------------

export const negotiationStatus = v.union(
  v.literal("open"),
  v.literal("agreed"),
  v.literal("rejected"),
  v.literal("expired"),
  v.literal("failed"),
);
export const negotiationParty = v.union(v.literal("buyer"), v.literal("seller"), v.literal("system"));
export const negotiationMessageKind = v.union(
  v.literal("ask"),
  v.literal("offer"),
  v.literal("counter"),
  v.literal("accept"),
  v.literal("reject"),
  v.literal("agreement"),
  v.literal("expired"),
  v.literal("failed"),
);

export const negotiationFields = {
  workspaceId: v.id("workspaces"),
  billboardId: v.id("billboards"),
  advertiserId: v.id("advertisers"),
  campaignId: v.id("campaigns"),
  agentKeyId: v.id("agentKeys"),
  slotIds: v.array(v.id("slots")),
  status: negotiationStatus,
  /** Sum of screen prices when the negotiation opened. */
  screenMinor: v.number(),
  /** Seller's opening ask (posted price for this company, never below the floor). */
  askMinor: v.number(),
  /** Seller never agrees below this: max(screen x floor ratio, reserve floor x slots). Not shown to the buyer. */
  floorMinor: v.number(),
  /** Seller's current position (last ask or counter). */
  sellerMinor: v.number(),
  /** Buyer's last offer, if any. */
  buyerMinor: v.optional(v.number()),
  /** Buyer offers made so far. */
  rounds: v.number(),
  maxRounds: v.number(),
  offerTtlMs: v.number(),
  /** The seller's current position is valid until then. */
  offerExpiresAt: v.number(),
  agreedMinor: v.optional(v.number()),
  quoteId: v.optional(v.id("quotes")),
  holdId: v.optional(v.id("holds")),
  closedReason: v.optional(v.string()),
  traceId: v.string(),
  updatedAt: v.number(),
};

export const negotiationMessageFields = {
  negotiationId: v.id("negotiations"),
  workspaceId: v.id("workspaces"),
  advertiserId: v.id("advertisers"),
  from: negotiationParty,
  /** Audit identity, e.g. "agent:Nvidia/demo-agent" or "seller-agent:Moscone Media". */
  actor: v.string(),
  kind: negotiationMessageKind,
  amountMinor: v.optional(v.number()),
  /** Deterministic reasoning (code decides every number). */
  reasoning: v.string(),
  /** Optional prose rewrite of `reasoning` (Claude narrate hook); never changes numbers. */
  narration: v.optional(v.string()),
  createdAt: v.number(),
};

export const dataProduct = v.literal("audience_report");

/** Pay-per-call data sold by a host's seller agent over x402 (ADR 0005). */
export const dataSaleFields = {
  workspaceId: v.id("workspaces"),
  advertiserId: v.id("advertisers"),
  agentKeyId: v.id("agentKeys"),
  billboardId: v.id("billboards"),
  product: dataProduct,
  amountMinor: v.number(),
  /** Settlement transaction hash (unique: replays don't double count). */
  txHash: v.string(),
  network: v.string(),
  payer: v.optional(v.string()),
  recordedAt: v.number(),
};

export const watchTrigger = v.union(
  v.literal("available"),
  v.literal("price_drop"),
  v.literal("last_minute"),
  v.literal("auction_open"),
);
export const watchDelivery = v.union(v.literal("inbox"), v.literal("agent"));
export const deliveryStatus = v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed"));

/** Customer "tell me when a spot fits" rule (ADR 0004). */
export const watchRuleFields = {
  advertiserId: v.id("advertisers"),
  campaignId: v.id("campaigns"),
  name: v.string(),
  cities: v.optional(v.array(v.string())),
  billboardIds: v.optional(v.array(v.id("billboards"))),
  /** 0..1 audience match between the screen and the campaign's target audience. */
  minMatch: v.optional(v.number()),
  /** Max screen price per 15-minute slot. */
  maxPriceMinor: v.number(),
  /** 0 = Sunday .. 6 = Saturday, in the screen's local time. */
  daysOfWeek: v.optional(v.array(v.number())),
  /** Local hours [hourStart, hourEnd), 0..24. */
  hourStart: v.optional(v.number()),
  hourEnd: v.optional(v.number()),
  dateFrom: v.optional(v.number()),
  dateTo: v.optional(v.number()),
  triggers: v.array(watchTrigger),
  delivery: v.array(watchDelivery),
  /** Agent key whose webhookUrl receives "agent" deliveries. */
  agentKeyId: v.optional(v.id("agentKeys")),
  active: v.boolean(),
  createdBy: v.string(),
};

export const alertSlot = v.object({
  slotId: v.id("slots"),
  startAt: v.number(),
  endAt: v.number(),
  screenPriceMinor: v.number(),
});

export const agentDeliveryState = v.object({
  status: deliveryStatus,
  attempts: v.number(),
  lastError: v.optional(v.string()),
  lastAttemptAt: v.optional(v.number()),
  deliveredAt: v.optional(v.number()),
});

/** Alert triggers: watch-rule triggers plus seller-agent flash offers (ADR 0006). */
export const alertTrigger = v.union(
  v.literal("available"),
  v.literal("price_drop"),
  v.literal("last_minute"),
  v.literal("auction_open"),
  v.literal("flash_offer"),
);

export const alertFields = {
  advertiserId: v.id("advertisers"),
  /** Watch rule that fired; absent for flash offers. */
  ruleId: v.optional(v.id("watchRules")),
  campaignId: v.id("campaigns"),
  trigger: alertTrigger,
  /** Flash offer behind a `flash_offer` alert (ADR 0006). */
  flashOfferId: v.optional(v.id("flashOffers")),
  billboardId: v.id("billboards"),
  workspaceId: v.optional(v.id("workspaces")),
  slotIds: v.array(v.id("slots")),
  /** First (up to 5) matching slots with their screen price at alert time. */
  slots: v.array(alertSlot),
  /** All matching slots found in this pass (slots[] is capped). */
  matchCount: v.number(),
  /** Lowest screen price among the alerted slots. */
  priceMinor: v.number(),
  auctionId: v.optional(v.id("auctions")),
  reason: v.string(),
  createdAt: v.number(),
  readAt: v.optional(v.number()),
  /** Set when the company's agent acknowledged it over the API. */
  ackedAt: v.optional(v.number()),
  inbox: v.object({ status: deliveryStatus }),
  agent: v.optional(agentDeliveryState),
};

// ---------------------------------------------------------------------------
// Live moments (ADR 0006): crowd -> flash offers -> paid playback
// ---------------------------------------------------------------------------

export const standingPolicy = v.union(v.literal("auto_accept"), v.literal("counter"), v.literal("pass"));

/** A buyer agent's standing instructions (on its agent key). Shared with agents in each offer; enforced server-side. */
export const standingInstructions = v.object({
  maxPricePerSpotMinor: v.number(),
  minRelevantViewers: v.number(),
  dailyBudgetMinor: v.number(),
  /** Legacy: kept so old rows validate; no new code writes it. */
  policy: v.optional(standingPolicy),
  /** For "counter": offer this share of the asking price (0.5..1). */
  counterRatio: v.optional(v.number()),
});

export const momentTrigger = v.union(
  v.literal("arrivals"),
  v.literal("event"),
  /** Legacy: kept so old rows validate; no new code writes it. */
  v.literal("simulated"),
  v.literal("queue"),
  v.literal("reoffer"),
  v.literal("next_spot"),
);
export const momentStatus = v.union(
  v.literal("offering"),
  v.literal("bidding"),
  v.literal("negotiating"),
  v.literal("awarded"),
  v.literal("paid"),
  v.literal("playing"),
  v.literal("no_takers"),
  v.literal("failed"),
);
export const momentStep = v.object({
  key: v.string(),
  label: v.string(),
  at: v.number(),
  detail: v.optional(v.string()),
});
export const paymentMode = v.union(
  v.literal("x402"),
  /** Legacy: kept so old rows validate; no new code writes it. */
  v.literal("rehearsal"),
);

export const momentFields = {
  workspaceId: v.id("workspaces"),
  billboardId: v.id("billboards"),
  trigger: momentTrigger,
  status: momentStatus,
  startedAt: v.number(),
  /** Trailing 15-minute crowd when detected. */
  crowd: v.number(),
  /** Best audience segment and its share (max of screen and event mix). */
  segment: v.string(),
  segmentShare: v.number(),
  relevantViewers: v.number(),
  eventName: v.optional(v.string()),
  crowdSource: v.string(),
  reasoning: v.string(),
  slotId: v.id("slots"),
  spotStartAt: v.number(),
  spotEndAt: v.number(),
  /** The opening price of the live auction. */
  priceMinor: v.number(),
  /** The published minimum price. */
  floorMinor: v.number(),
  valueMinor: v.optional(v.number()),
  peopleInView: v.optional(v.number()),
  plays: v.optional(v.number()),
  impressions: v.optional(v.number()),
  priceWhy: v.optional(v.string()),
  leaderOfferId: v.optional(v.id("flashOffers")),
  currentMinor: v.optional(v.number()),
  biddingClosesAt: v.optional(v.number()),
  hardClosesAt: v.optional(v.number()),
  extensions: v.optional(v.number()),
  reofferRound: v.optional(v.number()),
  sellerMinor: v.optional(v.number()),
  negotiationOfferId: v.optional(v.id("flashOffers")),
  negotiationRound: v.optional(v.number()),
  offerClosesAt: v.number(),
  winnerOfferId: v.optional(v.id("flashOffers")),
  holdId: v.optional(v.id("holds")),
  bookingId: v.optional(v.id("bookings")),
  paidMinor: v.optional(v.number()),
  paymentTx: v.optional(v.string()),
  paymentNetwork: v.optional(v.string()),
  paymentMode: v.optional(paymentMode),
  paymentBlocked: v.optional(v.string()),
  firstFrameAt: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  steps: v.array(momentStep),
};

export const flashOfferStatus = v.union(
  v.literal("sent"),
  v.literal("accepted"),
  v.literal("countered"),
  v.literal("passed"),
  v.literal("expired"),
  v.literal("won"),
  v.literal("lost"),
  v.literal("defaulted"),
);

export const flashOfferFields = {
  momentId: v.id("moments"),
  workspaceId: v.id("workspaces"),
  advertiserId: v.id("advertisers"),
  campaignId: v.id("campaigns"),
  agentKeyId: v.id("agentKeys"),
  /** Asking price (the moment's pro-rata screen price). */
  priceMinor: v.number(),
  /** Relevant viewers for this campaign's audience. */
  relevantViewers: v.number(),
  matchScore: v.number(),
  status: flashOfferStatus,
  replyAmountMinor: v.optional(v.number()),
  replyReasoning: v.optional(v.string()),
  repliedAt: v.optional(v.number()),
  holdId: v.optional(v.id("holds")),
  /** Legacy: kept so old rows validate; no new code writes it. */
  simulatedAgent: v.optional(v.boolean()),
  bidCount: v.optional(v.number()),
  lastBidMinor: v.optional(v.number()),
  delivery: agentDeliveryState,
  sentAt: v.number(),
};

export const accountType = v.union(v.literal("host"), v.literal("customer"));
export const workspaceRole = v.union(v.literal("owner"), v.literal("operator"));
export const companyRole = v.union(v.literal("owner"), v.literal("member"));

export default defineSchema({
  // Convex Auth: users, sessions, accounts, ... (users.email is indexed as "email").
  ...authTables,

  /** One per user: which side of the marketplace they signed up for. */
  profiles: defineTable({
    userId: v.id("users"),
    accountType,
    /** Host: workspace the console/finance views use. */
    activeWorkspaceId: v.optional(v.id("workspaces")),
  }).index("by_userId", ["userId"]),

  /** Host side: a company that owns screens (ADR 0004). */
  workspaces: defineTable({
    name: v.string(),
    city: v.string(),
    ownerUserId: v.optional(v.id("users")),
    /** x402 payouts for this workspace's sales (EVM address). */
    payoutAddress: v.optional(v.string()),
    /** Seller agent policy (ADR 0005). Missing = defaults in lib/negotiation.ts. */
    negotiationFloorRatio: v.optional(v.number()),
    negotiationMaxRounds: v.optional(v.number()),
    negotiationOfferTtlMs: v.optional(v.number()),
    /** Moment detector (ADR 0006). Missing = defaults in lib/moment.ts. */
    momentEnabled: v.optional(v.boolean()),
    /** Legacy: kept so old rows validate; no new code writes it. */
    momentMinRelevantViewers: v.optional(v.number()),
    /** Legacy: kept so old rows validate; no new code writes it. */
    momentCooldownMs: v.optional(v.number()),
    momentMinPeopleInView: v.optional(v.number()),
    momentResponseWindowMs: v.optional(v.number()),
    momentMinMatch: v.optional(v.number()),
    /** Legacy: kept so old rows validate; no new code writes it. Owner-only, OFF by default: settle a blocked winner with a labeled REHEARSAL (simulated) payment. */
    rehearsalSettlement: v.optional(v.boolean()),
  }).index("by_name", ["name"]),

  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    email: v.string(),
    role: workspaceRole,
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"])
    .index("by_workspace_and_user", ["workspaceId", "userId"]),

  /** Customer side: people who act for a customer company. */
  advertiserMembers: defineTable({
    advertiserId: v.id("advertisers"),
    userId: v.id("users"),
    email: v.string(),
    role: companyRole,
  })
    .index("by_advertiser", ["advertiserId"])
    .index("by_user", ["userId"])
    .index("by_advertiser_and_user", ["advertiserId", "userId"]),

  /**
   * Customer-issued agent keys (ADR 0004). The key itself is shown once and
   * stored only as a SHA-256 hash; the webhook secret signs alerts (step 3).
   */
  agentKeys: defineTable({
    advertiserId: v.id("advertisers"),
    name: v.string(),
    /** Public part shown in lists, e.g. "bos_agent_3f9a1c2e". */
    prefix: v.string(),
    keyHash: v.string(),
    scopes: v.array(agentScope),
    /** If set, the key may only act for these campaigns. */
    campaignIds: v.optional(v.array(v.id("campaigns"))),
    /** Max committed spend: active holds + bookings from this key + leading auction bids. */
    budgetCapMinor: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    webhookUrl: v.optional(v.string()),
    webhookSecret: v.string(),
    /** Standing instructions for flash offers (ADR 0006). */
    standing: v.optional(standingInstructions),
    lastUsedAt: v.optional(v.number()),
    createdBy: v.string(),
    /** Fixed-window rate limit state. */
    rateWindowStart: v.optional(v.number()),
    rateWindowCount: v.optional(v.number()),
  })
    .index("by_hash", ["keyHash"])
    .index("by_advertiser", ["advertiserId"]),

  watchRules: defineTable(watchRuleFields)
    .index("by_advertiser", ["advertiserId"])
    .index("by_active", ["active"]),

  /** Per rule x slot memory: which triggers already fired, and the last price seen (for price_drop). */
  watchMatches: defineTable({
    ruleId: v.id("watchRules"),
    slotId: v.id("slots"),
    lastPriceMinor: v.number(),
    fired: v.array(watchTrigger),
    updatedAt: v.number(),
  }).index("by_rule_and_slot", ["ruleId", "slotId"]),

  negotiations: defineTable(negotiationFields)
    .index("by_workspace", ["workspaceId"])
    .index("by_advertiser", ["advertiserId"])
    .index("by_agentKey_and_status", ["agentKeyId", "status"]),

  negotiationMessages: defineTable(negotiationMessageFields).index("by_negotiation", ["negotiationId"]),

  /** Short-lived lock: one x402 settle attempt per resource at a time (ADR 0006). */
  paymentLocks: defineTable({ key: v.string(), expiresAt: v.number() }).index("by_key", ["key"]),

  dataSales: defineTable(dataSaleFields)
    .index("by_workspace", ["workspaceId"])
    .index("by_advertiser", ["advertiserId"])
    .index("by_txHash", ["txHash"]),

  moments: defineTable(momentFields)
    .index("by_workspace", ["workspaceId"])
    .index("by_billboard", ["billboardId"])
    .index("by_hold", ["holdId"])
    .index("by_booking", ["bookingId"]),

  momentBids: defineTable({
    momentId: v.id("moments"),
    offerId: v.id("flashOffers"),
    advertiserId: v.id("advertisers"),
    kind: v.union(v.literal("bid"), v.literal("buyer_offer"), v.literal("seller_counter")),
    amountMinor: v.number(),
    at: v.number(),
    reasoning: v.optional(v.string()),
  }).index("by_moment", ["momentId", "at"]),

  companyAgents: defineTable({
    advertiserId: v.id("advertisers"),
    campaignId: v.id("campaigns"),
    agentKeyId: v.id("agentKeys"),
    keyCiphertext: v.string(),
    keyIv: v.string(),
    walletName: v.string(),
    walletAddress: v.optional(v.string()),
    balanceMinor: v.optional(v.number()),
    balanceAt: v.optional(v.number()),
    enabled: v.boolean(),
    topUpDay: v.optional(v.string()),
    topUpCount: v.optional(v.number()),
    lastAction: v.optional(v.string()),
    lastActionAt: v.optional(v.number()),
    /** Last USDC faucet claim made by `ensureWallet` (at most one per 24 h per company). */
    faucetClaimedAt: v.optional(v.number()),
  }).index("by_advertiser", ["advertiserId"]),

  flashOffers: defineTable(flashOfferFields)
    .index("by_moment", ["momentId"])
    .index("by_advertiser", ["advertiserId"])
    .index("by_hold", ["holdId"]),

  /** A host approved this campaign's creative for its screens: "ready to play" (ADR 0006). */
  creativeApprovals: defineTable({
    campaignId: v.id("campaigns"),
    workspaceId: v.id("workspaces"),
    approvedBy: v.string(),
    approvedAt: v.number(),
  })
    .index("by_workspace_and_campaign", ["workspaceId", "campaignId"])
    .index("by_campaign", ["campaignId"]),

  /**
   * Legacy: kept so old rows validate; no new code writes it.
   * Hosted demo customer agents (labeled "simulated customer agent"). The agent
   * key is stored AES-GCM encrypted (key derived from INTERNAL_API_SECRET) and
   * never returned by any query.
   */
  demoAgents: defineTable({
    advertiserId: v.id("advertisers"),
    slug: v.string(),
    campaignId: v.id("campaigns"),
    agentKeyId: v.id("agentKeys"),
    keyCiphertext: v.string(),
    keyIv: v.string(),
    walletName: v.string(),
    /** Small "think time" before replying, so replies arrive in a realistic order. */
    thinkMs: v.number(),
    lastAction: v.optional(v.string()),
    lastActionAt: v.optional(v.number()),
  }).index("by_advertiser", ["advertiserId"]),

  alerts: defineTable(alertFields)
    .index("by_advertiser", ["advertiserId"])
    .index("by_advertiser_and_readAt", ["advertiserId", "readAt"])
    .index("by_advertiser_and_ackedAt_and_createdAt", ["advertiserId", "ackedAt", "createdAt"])
    .index("by_rule", ["ruleId"]),

  /** LEGACY (pre ADR 0004): read once by the tenancy migration, then unused. */
  operators: defineTable({
    userId: v.id("users"),
    email: v.string(),
    /** "system:first-user" or "operator:<email>" */
    grantedBy: v.string(),
  })
    .index("by_userId", ["userId"])
    .index("by_email", ["email"]),

  billboards: defineTable(billboardFields).index("by_name", ["name"]).index("by_workspace", ["workspaceId"]),

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

  quotes: defineTable(quoteFields)
    .index("by_campaign", ["campaignId"])
    .index("by_billboard_and_expiresAt", ["billboardId", "expiresAt"])
    .index("by_workspace", ["workspaceId"]),

  auctions: defineTable(auctionFields)
    .index("by_status_and_endsAt", ["status", "endsAt"])
    .index("by_billboard_and_status", ["billboardId", "status"])
    .index("by_workspace", ["workspaceId"]),

  auctionParticipants: defineTable(auctionParticipantFields)
    .index("by_auction_and_campaign", ["auctionId", "campaignId"])
    .index("by_auction", ["auctionId"])
    .index("by_agentKey", ["agentKeyId"]),

  bids: defineTable(bidFields).index("by_auction", ["auctionId"]),

  autoBids: defineTable(autoBidFields).index("by_auction_and_campaign", ["auctionId", "campaignId"]),

  companyAssessments: defineTable(companyAssessmentFields).index("by_advertiser_and_assessedAt", [
    "advertiserId",
    "assessedAt",
  ]),

  events: defineTable(eventFields).index("by_billboard_and_startsAt", ["billboardId", "startsAt"]),

  priceHistory: defineTable(priceHistoryFields)
    .index("by_billboard_and_band_and_recordedAt", ["billboardId", "hourBand", "recordedAt"])
    .index("by_recordedAt", ["recordedAt"]),

  holds: defineTable(holdFields)
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_quote_and_status", ["quoteId", "status"])
    .index("by_billboard_and_status", ["billboardId", "status"])
    .index("by_agentKey_and_status", ["agentKeyId", "status"]),

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
    .index("by_bankTransaction", ["bankTransactionId"])
    .index("by_workspace_and_status", ["workspaceId", "status"]),

  audienceAggregates: defineTable(audienceAggregateFields).index(
    "by_billboard_and_bucketStart",
    ["billboardId", "bucketStart"],
  ),

  invoices: defineTable(invoiceFields)
    .index("by_number", ["number"])
    .index("by_advertiser", ["advertiserId"])
    .index("by_advertiser_and_status", ["advertiserId", "status"])
    .index("by_status_and_dueAt", ["status", "dueAt"])
    .index("by_workspace_and_status_and_dueAt", ["workspaceId", "status", "dueAt"]),

  bankTransactions: defineTable(bankTransactionFields)
    .index("by_source_and_externalId", ["source", "externalId"])
    .index("by_status_and_postedAt", ["status", "postedAt"])
    .index("by_postedAt", ["postedAt"])
    .index("by_workspace_and_status_and_postedAt", ["workspaceId", "status", "postedAt"])
    .index("by_workspace_and_postedAt", ["workspaceId", "postedAt"]),

  paymentApplications: defineTable(paymentApplicationFields)
    .index("by_invoice", ["invoiceId"])
    .index("by_bankTransaction", ["bankTransactionId"]),

  approvals: defineTable(approvalFields)
    .index("by_status", ["status"])
    .index("by_financeException", ["financeExceptionId"])
    .index("by_subject", ["subjectId"])
    .index("by_workspace_and_status", ["workspaceId", "status"]),

  collectionTasks: defineTable(collectionTaskFields)
    .index("by_invoice", ["invoiceId"])
    .index("by_status", ["status"])
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_and_status", ["workspaceId", "status"]),

  /** Monotonic counters (invoice numbers). */
  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),

  playbackEvents: defineTable(playbackEventFields)
    .index("by_slot_and_status", ["slotId", "status"])
    .index("by_billboard", ["billboardId"]),

  auditEvents: defineTable(auditEventFields)
    .index("by_trace", ["traceId"])
    .index("by_subject", ["subjectId"])
    .index("by_workspace", ["workspaceId"]),
});
