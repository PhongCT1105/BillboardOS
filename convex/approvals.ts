import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { approvalAction, approvalFields, approvalStatus } from "./schema";
import { recordAudit } from "./lib/audit";
import {
  createApproval,
  invoiceBalance,
  resolveFinanceException,
  settleInvoice,
} from "./lib/finance";
import { usd } from "./lib/reconcile";
import { requireOperator } from "./lib/operator";

/**
 * Controls (segregation of duties). Agents request through internal paths
 * ("agent:*"); people request and decide as signed-in operators, whose
 * identity ("operator:<email>") comes from the session, never from arguments.
 * Only an operator who is not the requester may DECIDE. Executing an approved
 * request is the only way write-offs, refunds and manual matches change
 * ledger state, and the only way their finance exceptions get resolved.
 */

type SubjectRef =
  | { kind: "invoice"; doc: Doc<"invoices"> }
  | { kind: "payment"; doc: Doc<"payments"> }
  | { kind: "bank_transaction"; doc: Doc<"bankTransactions"> };

async function loadSubject(ctx: MutationCtx, subjectId: string): Promise<SubjectRef | null> {
  const invoiceId = ctx.db.normalizeId("invoices", subjectId);
  if (invoiceId) {
    const doc = await ctx.db.get(invoiceId);
    return doc ? { kind: "invoice", doc } : null;
  }
  const paymentId = ctx.db.normalizeId("payments", subjectId);
  if (paymentId) {
    const doc = await ctx.db.get(paymentId);
    return doc ? { kind: "payment", doc } : null;
  }
  const bankId = ctx.db.normalizeId("bankTransactions", subjectId);
  if (bankId) {
    const doc = await ctx.db.get(bankId);
    return doc ? { kind: "bank_transaction", doc } : null;
  }
  return null;
}

function bankUnapplied(t: Doc<"bankTransactions">): number {
  return t.amountMinor - t.appliedMinor - (t.refundedMinor ?? 0);
}

function invalid(message: string): never {
  throw new ConvexError({ code: "INVALID_INPUT", message });
}

/** Validate that the action fits the subject and the amount fits the open balance. */
async function checkRequest(
  ctx: MutationCtx,
  action: Doc<"approvals">["action"],
  subject: SubjectRef,
  amountMinor: number,
  invoiceId: Id<"invoices"> | undefined,
): Promise<void> {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    invalid("amountMinor must be a positive integer (US cents)");
  }
  switch (action) {
    case "write_off":
    case "escalate_collection": {
      if (subject.kind !== "invoice") invalid(`${action} applies to an invoice`);
      const balance = invoiceBalance(subject.doc);
      if (amountMinor > balance) invalid(`Amount exceeds ${subject.doc.number} balance ${usd(balance)}`);
      return;
    }
    case "refund": {
      if (subject.kind === "payment") {
        if (subject.doc.status !== "exception") invalid("Only payments in exception can be refunded");
        if (amountMinor > subject.doc.amountMinor) invalid("Amount exceeds the payment");
        return;
      }
      if (subject.kind === "bank_transaction") {
        if (amountMinor > bankUnapplied(subject.doc)) {
          invalid(`Amount exceeds unapplied cash ${usd(bankUnapplied(subject.doc))}`);
        }
        return;
      }
      invalid("refund applies to a payment or a bank transaction");
      return;
    }
    case "apply_manual_match": {
      if (subject.kind !== "bank_transaction") invalid("apply_manual_match applies to a bank transaction");
      if (!invoiceId) invalid("apply_manual_match needs invoiceId");
      const inv = await ctx.db.get(invoiceId);
      if (!inv) throw new ConvexError({ code: "NOT_FOUND", message: "Invoice not found" });
      if (amountMinor > bankUnapplied(subject.doc)) invalid("Amount exceeds unapplied cash on the bank line");
      if (amountMinor > invoiceBalance(inv)) invalid(`Amount exceeds ${inv.number} balance`);
      return;
    }
  }
}

/** A signed-in operator files a request for another operator's approval. Never executes anything. */
export const request = mutation({
  args: {
    action: approvalAction,
    /** Id of the invoice, payment or bank transaction the action is about. */
    subjectId: v.string(),
    amountMinor: v.number(),
    reason: v.string(),
    /** Required for apply_manual_match: the invoice to apply the bank line to. */
    invoiceId: v.optional(v.id("invoices")),
    /** Exception this request would resolve, if any. */
    financeExceptionId: v.optional(v.id("financeExceptions")),
  },
  returns: v.object({ approvalId: v.id("approvals"), status: approvalStatus, replayed: v.boolean() }),
  handler: async (ctx, args) => {
    const operator = await requireOperator(ctx);
    const subject = await loadSubject(ctx, args.subjectId);
    if (!subject) throw new ConvexError({ code: "NOT_FOUND", message: "Subject not found" });
    await checkRequest(ctx, args.action, subject, args.amountMinor, args.invoiceId);
    const r = await createApproval(
      ctx,
      {
        action: args.action,
        subjectKind: subject.kind,
        subjectId: subject.doc._id,
        amountMinor: args.amountMinor,
        requestedBy: operator.actor,
        reason: args.reason,
        invoiceId: args.invoiceId,
        financeExceptionId: args.financeExceptionId,
      },
      `approval:${subject.doc._id}`,
    );
    const doc = (await ctx.db.get(r.approvalId))!;
    return { approvalId: r.approvalId, status: doc.status, replayed: r.replayed };
  },
});

/**
 * Controller decision by the signed-in operator. Hard rules: approver !=
 * requester, and no "agent:*" identity can approve. Approving executes the action immediately; if the
 * world changed while the request waited, execution is skipped and recorded.
 */
export const decide = mutation({
  args: {
    approvalId: v.id("approvals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    note: v.string(),
  },
  returns: v.object({
    approvalId: v.id("approvals"),
    status: approvalStatus,
    executionResult: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const approver = (await requireOperator(ctx)).actor;
    const note = args.note.trim().slice(0, 1000);
    const approval = await ctx.db.get(args.approvalId);
    if (!approval) throw new ConvexError({ code: "NOT_FOUND", message: "Approval not found" });
    if (approval.status !== "pending") {
      throw new ConvexError({ code: "NOT_PENDING", message: `Approval is already ${approval.status}` });
    }
    if (approver.toLowerCase().startsWith("agent:")) {
      throw new ConvexError({
        code: "AGENT_CANNOT_APPROVE",
        message: "Agents can request approvals but never approve them",
      });
    }
    if (approver.toLowerCase() === approval.requestedBy.toLowerCase()) {
      throw new ConvexError({
        code: "SOD_VIOLATION",
        message: "Segregation of duties: the requester cannot approve their own request",
      });
    }
    if (args.decision === "rejected" && note.length === 0) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "A rejection needs a note" });
    }

    const traceId = `approval:${approval.subjectId}`;
    const now = Date.now();
    await ctx.db.patch(approval._id, {
      status: args.decision,
      decidedBy: approver,
      decidedAt: now,
      decisionNote: note || undefined,
    });
    await recordAudit(ctx, {
      traceId,
      actor: approver,
      type: args.decision === "approved" ? "approval.approved" : "approval.rejected",
      subjectId: approval._id,
      reason: `${approval.action} requested by ${approval.requestedBy}: ${note || "(no note)"}`.slice(0, 1000),
      data: { action: approval.action, amountMinor: approval.amountMinor },
    });

    let executionResult: string | null = null;
    if (args.decision === "approved") {
      executionResult = await execute(ctx, approval, approver, traceId);
    } else {
      executionResult = await onRejected(ctx, approval, approver, note, traceId);
    }
    if (executionResult !== null) {
      await ctx.db.patch(approval._id, { executionResult });
      await recordAudit(ctx, {
        traceId,
        actor: approver,
        type: "approval.executed",
        subjectId: approval._id,
        reason: executionResult.slice(0, 1000),
        data: { action: approval.action, decision: args.decision },
      });
    }
    return { approvalId: approval._id, status: args.decision, executionResult };
  },
});

async function execute(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  approver: string,
  traceId: string,
): Promise<string> {
  const now = Date.now();
  const subject = await loadSubject(ctx, approval.subjectId);
  if (!subject) return "Skipped: subject no longer exists.";
  // Re-check against current state: the request may have waited a while.
  try {
    await checkRequest(ctx, approval.action, subject, approval.amountMinor, approval.invoiceId);
  } catch (error) {
    const why = error instanceof ConvexError ? (error.data as { message: string }).message : String(error);
    return `Skipped: state changed since the request (${why}).`;
  }
  const resolve = async (text: string) => {
    if (approval.financeExceptionId) {
      await resolveFinanceException(ctx, approval.financeExceptionId, text, approver, traceId);
    }
  };

  switch (approval.action) {
    case "write_off": {
      const inv = subject.doc as Doc<"invoices">;
      await ctx.db.patch(inv._id, { writtenOffMinor: inv.writtenOffMinor + approval.amountMinor });
      await settleInvoice(ctx, inv._id, now, approver, traceId);
      const text = `Wrote off ${usd(approval.amountMinor)} on ${inv.number} (requested by ${approval.requestedBy}, approved by ${approver}).`;
      await resolve(text);
      return text;
    }
    case "refund": {
      if (subject.kind === "payment") {
        await ctx.db.patch(subject.doc._id, { status: "refunded" });
        const text = `Refund of ${usd(approval.amountMinor)} recorded for ${subject.doc.provider} payment ${subject.doc.externalRef}. Money movement via the provider is outside this system.`;
        await recordAudit(ctx, {
          traceId,
          actor: approver,
          type: "refund.recorded",
          subjectId: subject.doc._id,
          reason: text,
          data: { amountMinor: approval.amountMinor },
        });
        await resolve(text);
        return text;
      }
      const t = subject.doc as Doc<"bankTransactions">;
      const refundedMinor = (t.refundedMinor ?? 0) + approval.amountMinor;
      const fullyAccounted = t.appliedMinor + refundedMinor >= t.amountMinor;
      await ctx.db.patch(t._id, {
        refundedMinor,
        status: fullyAccounted && t.appliedMinor > 0 ? "matched" : t.status,
      });
      const text = `Refund of ${usd(approval.amountMinor)} unapplied cash recorded for bank line ${t.externalId}.`;
      await recordAudit(ctx, {
        traceId,
        actor: approver,
        type: "refund.recorded",
        subjectId: t._id,
        reason: text,
        data: { amountMinor: approval.amountMinor },
      });
      await resolve(text);
      return text;
    }
    case "apply_manual_match": {
      const t = subject.doc as Doc<"bankTransactions">;
      const inv = (await ctx.db.get(approval.invoiceId!))!;
      await ctx.db.insert("paymentApplications", {
        invoiceId: inv._id,
        bankTransactionId: t._id,
        amountMinor: approval.amountMinor,
        appliedBy: `${approval.requestedBy} (approved by ${approver})`,
        rule: "manual_match",
        evidence: `Manual match of ${usd(approval.amountMinor)} from ${t.externalId} (${t.payerName}) to ${inv.number}: ${approval.reason}`,
      });
      await ctx.db.patch(inv._id, { paidMinor: inv.paidMinor + approval.amountMinor });
      await settleInvoice(ctx, inv._id, t.postedAt, approver, traceId);
      const appliedMinor = t.appliedMinor + approval.amountMinor;
      const fullyAccounted = appliedMinor + (t.refundedMinor ?? 0) >= t.amountMinor;
      await ctx.db.patch(t._id, {
        appliedMinor,
        advertiserId: inv.advertiserId,
        status: fullyAccounted ? "matched" : "partially_applied",
      });
      const text = `Applied ${usd(approval.amountMinor)} from ${t.externalId} to ${inv.number}.`;
      await resolve(text);
      return text;
    }
    case "escalate_collection": {
      const inv = subject.doc as Doc<"invoices">;
      if (approval.collectionTaskId) {
        await ctx.db.patch(approval.collectionTaskId, {
          resolution: `Controller ${approver} took over collection of ${inv.number}.`,
        });
      }
      return `Escalation accepted: controller ${approver} owns collection of ${inv.number} (${usd(invoiceBalance(inv))} outstanding).`;
    }
  }
}

/** "The controller sometimes says no." Rejections leave state as-is, except escalations fall back to a firm reminder. */
async function onRejected(
  ctx: MutationCtx,
  approval: Doc<"approvals">,
  approver: string,
  note: string,
  traceId: string,
): Promise<string | null> {
  if (approval.action !== "escalate_collection" || !approval.collectionTaskId) return null;
  const task = await ctx.db.get(approval.collectionTaskId);
  if (!task) return null;
  await ctx.db.patch(task._id, {
    status: "resolved",
    resolution: `Controller ${approver} declined escalation: ${note}`,
  });
  const inv = await ctx.db.get(task.invoiceId);
  if (!inv || invoiceBalance(inv) === 0) return "Escalation declined; invoice already settled.";
  const firmId = await ctx.db.insert("collectionTasks", {
    invoiceId: task.invoiceId,
    advertiserId: task.advertiserId,
    tone: "firm",
    reason: `Controller declined escalation (${note}); continuing with a firm reminder. ${task.reason}`.slice(0, 1000),
    status: "planned",
    daysOverdue: task.daysOverdue,
    balanceMinor: invoiceBalance(inv),
    plannedAt: Date.now(),
  });
  await recordAudit(ctx, {
    traceId,
    actor: "agent:collections",
    type: "collection.planned",
    subjectId: firmId,
    reason: `Fallback firm reminder for ${inv.number} after controller declined escalation`,
  });
  return `Escalation declined; collections continues with a firm reminder for ${inv.number}.`;
}

/** Pending approvals, newest first (max 50), with a human-readable subject. */
export const pending = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("approvals"),
      _creationTime: v.number(),
      ...approvalFields,
      subjectLabel: v.string(),
    }),
  ),
  handler: async (ctx) => {
    await requireOperator(ctx);
    const rows = await ctx.db
      .query("approvals")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(50);
    const out = [];
    for (const a of rows) {
      let subjectLabel = a.subjectId;
      if (a.subjectKind === "invoice") {
        const id = ctx.db.normalizeId("invoices", a.subjectId);
        const inv = id ? await ctx.db.get(id) : null;
        if (inv) subjectLabel = `${inv.number} (${usd(invoiceBalance(inv))} open)`;
      } else if (a.subjectKind === "bank_transaction") {
        const id = ctx.db.normalizeId("bankTransactions", a.subjectId);
        const t = id ? await ctx.db.get(id) : null;
        if (t) subjectLabel = `Bank ${t.externalId}: ${t.payerName} ${usd(t.amountMinor)}`;
      } else {
        const id = ctx.db.normalizeId("payments", a.subjectId);
        const p = id ? await ctx.db.get(id) : null;
        if (p) subjectLabel = `${p.provider} payment ${p.externalRef} ${usd(p.amountMinor)}`;
      }
      if (a.invoiceId) {
        const inv = await ctx.db.get(a.invoiceId);
        if (inv) subjectLabel += ` -> ${inv.number}`;
      }
      out.push({ ...a, subjectLabel });
    }
    return out;
  },
});
