import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  bankSource,
  bankTransactionStatus,
  dataSource,
  invoiceStatus,
  reconcileRule,
} from "./schema";
import { financeExceptionDoc } from "./lib/validators";
import { invoiceBalance } from "./lib/finance";
import { daysOverdue } from "./lib/collections";
import { reconciliationSummary, runReconciliationBatch } from "./reconciliation";

/** Open finance exceptions needing operator review, newest first (max 100). */
export const openExceptions = query({
  args: {},
  returns: v.array(financeExceptionDoc),
  handler: async (ctx) => {
    return await ctx.db
      .query("financeExceptions")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .order("desc")
      .take(100);
  },
});

/**
 * Receivables: invoices with an open balance (open, partially_paid, disputed),
 * oldest due first. `daysOverdue` <= 0 means not yet due.
 */
export const receivables = query({
  args: { asOf: v.optional(v.number()) },
  returns: v.array(
    v.object({
      invoiceId: v.id("invoices"),
      number: v.string(),
      advertiserId: v.id("advertisers"),
      advertiserName: v.string(),
      paymentTerms: v.string(),
      description: v.string(),
      amountMinor: v.number(),
      paidMinor: v.number(),
      adjustmentMinor: v.number(),
      writtenOffMinor: v.number(),
      balanceMinor: v.number(),
      issuedAt: v.number(),
      dueAt: v.number(),
      daysOverdue: v.number(),
      status: invoiceStatus,
      source: dataSource,
    }),
  ),
  handler: async (ctx, args) => {
    const asOf = args.asOf ?? Date.now();
    const invoices: Doc<"invoices">[] = [];
    for (const status of ["open", "partially_paid", "disputed"] as const) {
      invoices.push(
        ...(await ctx.db
          .query("invoices")
          .withIndex("by_status_and_dueAt", (q) => q.eq("status", status))
          .take(100)),
      );
    }
    invoices.sort((a, b) => a.dueAt - b.dueAt);
    const advertisers = new Map<Id<"advertisers">, Doc<"advertisers"> | null>();
    const rows = [];
    for (const inv of invoices) {
      if (!advertisers.has(inv.advertiserId)) {
        advertisers.set(inv.advertiserId, await ctx.db.get(inv.advertiserId));
      }
      const adv = advertisers.get(inv.advertiserId);
      rows.push({
        invoiceId: inv._id,
        number: inv.number,
        advertiserId: inv.advertiserId,
        advertiserName: adv?.displayName ?? "Unknown advertiser",
        paymentTerms: adv?.paymentTerms ?? "unknown",
        description: inv.description,
        amountMinor: inv.amountMinor,
        paidMinor: inv.paidMinor,
        adjustmentMinor: inv.adjustmentMinor,
        writtenOffMinor: inv.writtenOffMinor,
        balanceMinor: invoiceBalance(inv),
        issuedAt: inv.issuedAt,
        dueAt: inv.dueAt,
        daysOverdue: daysOverdue(inv.dueAt, asOf),
        status: inv.status,
        source: inv.source,
      });
    }
    return rows;
  },
});

/** Recent bank lines (newest posted first, max 50) with how each was applied. */
export const bankFeed = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("bankTransactions"),
      source: bankSource,
      externalId: v.string(),
      amountMinor: v.number(),
      postedAt: v.number(),
      payerName: v.string(),
      memo: v.string(),
      status: bankTransactionStatus,
      appliedMinor: v.number(),
      refundedMinor: v.number(),
      unappliedMinor: v.number(),
      rule: v.optional(reconcileRule),
      note: v.optional(v.string()),
      advertiserName: v.optional(v.string()),
      duplicateOfExternalId: v.optional(v.string()),
      applications: v.array(
        v.object({
          invoiceId: v.id("invoices"),
          invoiceNumber: v.string(),
          amountMinor: v.number(),
          rule: reconcileRule,
          appliedBy: v.string(),
          evidence: v.string(),
        }),
      ),
      openExceptionKinds: v.array(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const lines = await ctx.db.query("bankTransactions").withIndex("by_postedAt").order("desc").take(50);
    const rows = [];
    for (const t of lines) {
      const apps = await ctx.db
        .query("paymentApplications")
        .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", t._id))
        .take(10);
      const applications = [];
      for (const a of apps) {
        const inv = await ctx.db.get(a.invoiceId);
        applications.push({
          invoiceId: a.invoiceId,
          invoiceNumber: inv?.number ?? "?",
          amountMinor: a.amountMinor,
          rule: a.rule,
          appliedBy: a.appliedBy,
          evidence: a.evidence,
        });
      }
      const exceptions = await ctx.db
        .query("financeExceptions")
        .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", t._id))
        .take(10);
      const advertiser = t.advertiserId ? await ctx.db.get(t.advertiserId) : null;
      const dupOf = t.duplicateOf ? await ctx.db.get(t.duplicateOf) : null;
      const refundedMinor = t.refundedMinor ?? 0;
      rows.push({
        _id: t._id,
        source: t.source,
        externalId: t.externalId,
        amountMinor: t.amountMinor,
        postedAt: t.postedAt,
        payerName: t.payerName,
        memo: t.memo,
        status: t.status,
        appliedMinor: t.appliedMinor,
        refundedMinor,
        unappliedMinor: t.amountMinor - t.appliedMinor - refundedMinor,
        rule: t.rule,
        note: t.note,
        advertiserName: advertiser?.displayName,
        duplicateOfExternalId: dupOf?.externalId,
        applications,
        openExceptionKinds: exceptions.filter((e) => e.status === "open").map((e) => e.kind),
      });
    }
    return rows;
  },
});

/**
 * Operator button: run the AR clerk over unmatched bank lines now.
 * Cash is applied as "agent:ar"; anything that needs a person becomes a
 * finance exception and/or an approval request.
 * TODO(auth): operator-only once auth exists.
 */
export const runReconciliation = mutation({
  args: {},
  returns: reconciliationSummary,
  handler: async (ctx) => runReconciliationBatch(ctx, "operator"),
});
