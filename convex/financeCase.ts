import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  approvalAction,
  approvalStatus,
  bankSource,
  collectionTone,
  financeExceptionKind,
} from "./schema";
import { resolveWorkspace } from "./lib/tenancy";

const RANK: Record<Doc<"financeExceptions">["kind"], number> = {
  short_payment: 0,
  overpayment: 1,
  unidentified_payment: 2,
  duplicate_payment: 3,
  payment_after_hold_expired: 4,
  amount_mismatch: 5,
  asset_mismatch: 6,
  winner_default: 7,
};

const SEATS = [
  {
    id: "ar",
    title: "Accounts receivable clerk",
    can: "Match bank lines to invoices and leave a record of the rule.",
    cannot: "Approve a refund, a write-off, or their own request.",
  },
  {
    id: "collections",
    title: "Collections specialist",
    can: "Set the follow-up tone from this payer's history.",
    cannot: "Send a chase or change payment terms.",
  },
  {
    id: "controller",
    title: "Controller",
    can: "Approve or reject what the clerk requested.",
    cannot: "Be the same person who requested it.",
  },
] as const;

function defense(kind: Doc<"financeExceptions">["kind"], invoiceNumber: string | null): string {
  const invoice = invoiceNumber ?? "the invoice";
  switch (kind) {
    case "short_payment":
      return `${invoice} is the contract. The bank line is the cash that arrived. The ledger keeps only that cash, and the unpaid balance stays open. The contract is not rewritten to match the deposit.`;
    case "overpayment":
      return `${invoice} is paid only up to the contract amount. The extra cash stays unapplied until the controller approves a refund. The clerk who found it cannot approve it.`;
    case "unidentified_payment":
      return "No invoice number and no known payer alias. The cash stays unapplied. A person has to name the customer before anything is posted.";
    case "duplicate_payment":
      return "This line repeats a payment that was already applied. It is not applied again.";
    case "payment_after_hold_expired":
      return "The hold had already ended, so the slot was not booked. The cash is on the books and a person decides the refund. The payment does not reopen the slot.";
    case "amount_mismatch":
      return "The payment amount does not match the quote. Nothing is booked until a person resolves the difference.";
    case "asset_mismatch":
      return "The payment asset does not match the quote currency. Nothing is booked on it.";
    case "winner_default":
      return "The auction winner did not pay in time. The slot is offered on, and the default stays on the record.";
  }
}

/**
 * The finance case a judge should see: one open disagreement, the sources,
 * and which seat is allowed to act. Read straight from the ledger.
 */
export const caseFile = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({
    seats: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        can: v.string(),
        cannot: v.string(),
      }),
    ),
    bankSource: v.union(bankSource, v.literal("none")),
    unmatchedLines: v.number(),
    openExceptions: v.number(),
    moment: v.union(
      v.null(),
      v.object({
        exceptionId: v.id("financeExceptions"),
        openedAt: v.number(),
        kind: financeExceptionKind,
        payerName: v.union(v.string(), v.null()),
        memo: v.union(v.string(), v.null()),
        bankSource: v.union(bankSource, v.null()),
        invoiceNumber: v.union(v.string(), v.null()),
        advertiserName: v.union(v.string(), v.null()),
        expectedMinor: v.number(),
        observedMinor: v.number(),
        evidence: v.string(),
        nextAction: v.string(),
        defense: v.string(),
        appliedBy: v.union(v.string(), v.null()),
        collections: v.union(
          v.null(),
          v.object({
            invoiceNumber: v.string(),
            tone: collectionTone,
            daysOverdue: v.number(),
            balanceMinor: v.number(),
            reason: v.string(),
          }),
        ),
        approval: v.union(
          v.null(),
          v.object({
            action: approvalAction,
            amountMinor: v.number(),
            requestedBy: v.string(),
            status: approvalStatus,
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const unmatched = await ctx.db
      .query("bankTransactions")
      .withIndex("by_workspace_and_status_and_postedAt", (q) =>
        q.eq("workspaceId", me.workspaceId).eq("status", "unmatched"),
      )
      .take(50);
    const recent = await ctx.db
      .query("bankTransactions")
      .withIndex("by_workspace_and_postedAt", (q) => q.eq("workspaceId", me.workspaceId))
      .order("desc")
      .take(20);
    const bankSource: "fixture" | "nessie" | "none" = recent.some((line) => line.source === "fixture")
      ? "fixture"
      : recent.some((line) => line.source === "nessie")
        ? "nessie"
        : "none";

    const open = await ctx.db
      .query("financeExceptions")
      .withIndex("by_workspace_and_status", (q) => q.eq("workspaceId", me.workspaceId).eq("status", "open"))
      .take(50);
    const picked = [...open].sort((a, b) => {
      const rank = RANK[a.kind] - RANK[b.kind];
      if (rank !== 0) return rank;
      return Math.abs(b.observedMinor - b.expectedMinor) - Math.abs(a.observedMinor - a.expectedMinor);
    })[0];

    if (!picked) {
      return {
        seats: [...SEATS],
        bankSource,
        unmatchedLines: unmatched.length,
        openExceptions: 0,
        moment: null,
      };
    }

    const bank = picked.bankTransactionId ? await ctx.db.get(picked.bankTransactionId) : null;
    const invoice = picked.invoiceId ? await ctx.db.get(picked.invoiceId) : null;
    const advertiser = picked.advertiserId
      ? await ctx.db.get(picked.advertiserId)
      : invoice
        ? await ctx.db.get(invoice.advertiserId)
        : null;
    const applications = picked.bankTransactionId
      ? await ctx.db
          .query("paymentApplications")
          .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", picked.bankTransactionId as Id<"bankTransactions">))
          .take(5)
      : [];
    const tasks = picked.invoiceId
      ? await ctx.db
          .query("collectionTasks")
          .withIndex("by_invoice", (q) => q.eq("invoiceId", picked.invoiceId as Id<"invoices">))
          .take(10)
      : [];
    const task = tasks.find((row) => row.status !== "resolved") ?? null;
    const taskInvoice = task ? await ctx.db.get(task.invoiceId) : null;
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_financeException", (q) => q.eq("financeExceptionId", picked._id))
      .take(5);
    const approval = approvals.find((row) => row.status === "pending") ?? approvals[0] ?? null;

    return {
      seats: [...SEATS],
      bankSource,
      unmatchedLines: unmatched.length,
      openExceptions: open.length,
      moment: {
        exceptionId: picked._id,
        openedAt: picked._creationTime,
        kind: picked.kind,
        payerName: bank?.payerName ?? null,
        memo: bank?.memo ?? null,
        bankSource: bank?.source ?? null,
        invoiceNumber: invoice?.number ?? null,
        advertiserName: advertiser?.displayName ?? null,
        expectedMinor: picked.expectedMinor,
        observedMinor: picked.observedMinor,
        evidence: picked.evidence,
        nextAction: picked.nextAction,
        defense: defense(picked.kind, invoice?.number ?? null),
        appliedBy: applications[0]?.appliedBy ?? null,
        collections: task && taskInvoice
          ? {
              invoiceNumber: taskInvoice.number,
              tone: task.tone,
              daysOverdue: task.daysOverdue,
              balanceMinor: task.balanceMinor,
              reason: task.reason,
            }
          : null,
        approval: approval
          ? {
              action: approval.action,
              amountMinor: approval.amountMinor,
              requestedBy: approval.requestedBy,
              status: approval.status,
            }
          : null,
      },
    };
  },
});
