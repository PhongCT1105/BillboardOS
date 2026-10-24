import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { bankTransactionStatus, reconcileRule } from "./schema";
import { recordAudit } from "./lib/audit";
import {
  createApproval,
  invoiceBalance,
  openFinanceException,
  settleInvoice,
} from "./lib/finance";
import {
  identifyPayer,
  parseInvoiceNumbers,
  reconcileLine,
  usd,
  type InvoiceCandidate,
  type ReconcileExceptionKind,
} from "./lib/reconcile";

/** The AR clerk seat. Applies cash automatically, never approves anything. */
export const AR_AGENT = "agent:ar";
const MAX_LINES_PER_RUN = 50;
const PRIOR_LINE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_PAYMENT_EXCEPTIONS_SWEPT = 20;

const NEXT_ACTION: Record<ReconcileExceptionKind, string> = {
  short_payment:
    "Collections to request the shortfall from the advertiser; controller may approve a write-off.",
  overpayment:
    "Excess held as unapplied cash. AR has requested a refund; controller must approve (or apply to a future invoice via manual match).",
  unidentified_payment:
    "Identify the payer, then request apply_manual_match for controller approval.",
  duplicate_payment:
    "Confirm with the bank whether this is a duplicate feed entry or a second real payment; if real, request a refund.",
};

export const reconciliationSummary = v.object({
  processed: v.number(),
  matched: v.number(),
  partiallyApplied: v.number(),
  needsReview: v.number(),
  applicationsCreated: v.number(),
  exceptionsOpened: v.number(),
  approvalsRequested: v.number(),
  lines: v.array(
    v.object({
      bankTransactionId: v.id("bankTransactions"),
      externalId: v.string(),
      status: bankTransactionStatus,
      rule: reconcileRule,
      explanation: v.array(v.string()),
    }),
  ),
});

function toCandidate(inv: Doc<"invoices">): InvoiceCandidate<Id<"invoices">, Id<"advertisers">> {
  return {
    id: inv._id,
    number: inv.number,
    advertiserId: inv.advertiserId,
    balanceMinor: invoiceBalance(inv),
    dueAt: inv.dueAt,
  };
}

/**
 * Run the AR clerk over unmatched bank lines (oldest first, max 50), then
 * file refund requests for booking-side payment exceptions that have none.
 */
export async function runReconciliationBatch(ctx: MutationCtx, triggeredBy: string) {
  const summary = {
    processed: 0,
    matched: 0,
    partiallyApplied: 0,
    needsReview: 0,
    applicationsCreated: 0,
    exceptionsOpened: 0,
    approvalsRequested: 0,
    lines: [] as {
      bankTransactionId: Id<"bankTransactions">;
      externalId: string;
      status: Doc<"bankTransactions">["status"];
      rule: Doc<"paymentApplications">["rule"];
      explanation: string[];
    }[],
  };

  const advertisers = await ctx.db.query("advertisers").take(200);
  const payers = advertisers.map((a) => ({
    id: a._id,
    displayName: a.displayName,
    aliases: a.payerAliases ?? [],
  }));

  const lines = await ctx.db
    .query("bankTransactions")
    .withIndex("by_status_and_postedAt", (q) => q.eq("status", "unmatched"))
    .take(MAX_LINES_PER_RUN);

  for (const line of lines) {
    const traceId = `bank:${line.source}:${line.externalId}`;

    // Referenced invoices (any status) by number.
    const referenced: Doc<"invoices">[] = [];
    for (const number of parseInvoiceNumbers(line.memo).slice(0, 10)) {
      const inv = await ctx.db
        .query("invoices")
        .withIndex("by_number", (q) => q.eq("number", number))
        .first();
      if (inv) referenced.push(inv);
    }

    // Open invoices of the identified payer.
    const { payer } = identifyPayer(line.payerName, payers);
    const payerOpen: Doc<"invoices">[] = [];
    if (payer) {
      for (const status of ["open", "partially_paid"] as const) {
        payerOpen.push(
          ...(await ctx.db
            .query("invoices")
            .withIndex("by_advertiser_and_status", (q) =>
              q.eq("advertiserId", payer.id).eq("status", status),
            )
            .take(25)),
        );
      }
    }

    // Earlier processed lines near this one, for duplicate detection.
    const nearby = await ctx.db
      .query("bankTransactions")
      .withIndex("by_postedAt", (q) =>
        q
          .gte("postedAt", line.postedAt - PRIOR_LINE_WINDOW_MS)
          .lte("postedAt", line.postedAt + PRIOR_LINE_WINDOW_MS),
      )
      .take(100);
    const priorLines = nearby
      .filter((p) => p._id !== line._id && p.status !== "unmatched" && !p.duplicateOf)
      .map((p) => ({
        id: p._id,
        externalId: p.externalId,
        amountMinor: p.amountMinor,
        postedAt: p.postedAt,
        payerName: p.payerName,
        memo: p.memo,
      }));

    const decision = reconcileLine({
      line: {
        id: line._id,
        externalId: line.externalId,
        amountMinor: line.amountMinor,
        postedAt: line.postedAt,
        payerName: line.payerName,
        memo: line.memo,
      },
      payers,
      referencedInvoices: referenced.map(toCandidate),
      payerOpenInvoices: payerOpen.map(toCandidate),
      priorLines,
    });

    // Apply cash.
    for (const app of decision.applications) {
      await ctx.db.insert("paymentApplications", {
        invoiceId: app.invoiceId,
        bankTransactionId: line._id,
        amountMinor: app.amountMinor,
        appliedBy: AR_AGENT,
        rule: decision.rule,
        evidence: app.evidence,
      });
      const inv = (await ctx.db.get(app.invoiceId))!;
      await ctx.db.patch(app.invoiceId, { paidMinor: inv.paidMinor + app.amountMinor });
      summary.applicationsCreated++;
    }
    for (const adj of decision.adjustments) {
      const inv = (await ctx.db.get(adj.invoiceId))!;
      await ctx.db.patch(adj.invoiceId, { adjustmentMinor: inv.adjustmentMinor + adj.amountMinor });
    }
    const touched = new Set([
      ...decision.applications.map((a) => a.invoiceId),
      ...decision.adjustments.map((a) => a.invoiceId),
    ]);
    for (const invoiceId of touched) {
      await settleInvoice(ctx, invoiceId, line.postedAt, AR_AGENT, traceId);
    }

    const appliedMinor = decision.applications.reduce((s, a) => s + a.amountMinor, 0);
    const notes = [
      ...decision.explanation,
      ...decision.adjustments.map((a) => a.note),
    ].join(" ");
    await ctx.db.patch(line._id, {
      status: decision.outcome,
      appliedMinor,
      advertiserId: decision.advertiserId ?? undefined,
      rule: decision.rule,
      note: notes.slice(0, 1000),
      duplicateOf: decision.duplicateOf ?? undefined,
    });

    // Differences that need a person.
    for (const ex of decision.exceptions) {
      const exceptionId = await openFinanceException(
        ctx,
        {
          kind: ex.kind,
          expectedMinor: ex.expectedMinor,
          observedMinor: ex.observedMinor,
          evidence: ex.evidence,
          nextAction: NEXT_ACTION[ex.kind],
          invoiceId: ex.invoiceId ?? undefined,
          bankTransactionId: line._id,
          advertiserId: decision.advertiserId ?? undefined,
        },
        AR_AGENT,
        traceId,
      );
      summary.exceptionsOpened++;
      if (ex.kind === "overpayment") {
        const excess = line.amountMinor - appliedMinor;
        if (excess > 0) {
          const r = await createApproval(
            ctx,
            {
              action: "refund",
              subjectKind: "bank_transaction",
              subjectId: line._id,
              amountMinor: excess,
              requestedBy: AR_AGENT,
              reason: `Refund ${usd(excess)} unapplied cash from ${line.externalId}: ${ex.evidence}`,
              financeExceptionId: exceptionId,
            },
            traceId,
          );
          if (!r.replayed) summary.approvalsRequested++;
        }
      }
    }

    await recordAudit(ctx, {
      traceId,
      actor: AR_AGENT,
      type: decision.outcome === "needs_review" ? "reconciliation.needs_review" : "reconciliation.applied",
      subjectId: line._id,
      reason: `${decision.rule}: ${decision.explanation.join(" ")}`.slice(0, 1000),
      data: {
        outcome: decision.outcome,
        rule: decision.rule,
        appliedMinor,
        invoiceNumbers: decision.applications.map((a) => a.invoiceNumber),
        triggeredBy,
      },
    });

    summary.processed++;
    if (decision.outcome === "matched") summary.matched++;
    else if (decision.outcome === "partially_applied") summary.partiallyApplied++;
    else summary.needsReview++;
    summary.lines.push({
      bankTransactionId: line._id,
      externalId: line.externalId,
      status: decision.outcome,
      rule: decision.rule,
      explanation: decision.explanation,
    });
  }

  // Booking-side payment exceptions (x402/manual) with no refund request yet.
  const paymentExceptions = await ctx.db
    .query("financeExceptions")
    .withIndex("by_status", (q) => q.eq("status", "open"))
    .order("desc")
    .take(MAX_PAYMENT_EXCEPTIONS_SWEPT);
  for (const ex of paymentExceptions) {
    if (!ex.paymentId) continue;
    const already = await ctx.db
      .query("approvals")
      .withIndex("by_financeException", (q) => q.eq("financeExceptionId", ex._id))
      .first();
    if (already) continue;
    const payment = await ctx.db.get(ex.paymentId);
    if (!payment || payment.status !== "exception") continue;
    const hold = ex.holdId ? await ctx.db.get(ex.holdId) : null;
    await createApproval(
      ctx,
      {
        action: "refund",
        subjectKind: "payment",
        subjectId: payment._id,
        amountMinor: payment.amountMinor,
        requestedBy: AR_AGENT,
        reason: `Refund ${usd(payment.amountMinor)} ${payment.provider} payment ${payment.externalRef}: ${ex.kind}. ${ex.evidence}`,
        financeExceptionId: ex._id,
      },
      hold?.traceId ?? `payment:${payment._id}`,
    );
    summary.approvalsRequested++;
  }

  return summary;
}

/** Cron/agent entry point for the AR clerk. */
export const run = internalMutation({
  args: {},
  returns: reconciliationSummary,
  handler: async (ctx) => runReconciliationBatch(ctx, AR_AGENT),
});
