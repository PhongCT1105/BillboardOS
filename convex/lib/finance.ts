import { ConvexError, type Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { approvalAction, approvalSubjectKind, financeExceptionKind } from "../schema";
import { recordAudit } from "./audit";

export const NET15_MS = 15 * 24 * 60 * 60 * 1000;
const FIRST_LIVE_INVOICE_NUMBER = 1100;

export type FinanceExceptionKind = Infer<typeof financeExceptionKind>;
export type ApprovalAction = Infer<typeof approvalAction>;
export type ApprovalSubjectKind = Infer<typeof approvalSubjectKind>;

/** Outstanding balance; never negative. */
export function invoiceBalance(inv: Doc<"invoices">): number {
  return Math.max(0, inv.amountMinor - inv.paidMinor - inv.adjustmentMinor - inv.writtenOffMinor);
}

/** Allocate the next unused "INV-<n>" (skips numbers taken by fixtures). */
export async function nextInvoiceNumber(ctx: MutationCtx): Promise<string> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", "invoice"))
    .unique();
  let value = counter?.value ?? FIRST_LIVE_INVOICE_NUMBER;
  for (let i = 0; i < 1000; i++, value++) {
    const number = `INV-${value}`;
    const taken = await ctx.db
      .query("invoices")
      .withIndex("by_number", (q) => q.eq("number", number))
      .first();
    if (!taken) {
      if (counter) await ctx.db.patch(counter._id, { value: value + 1 });
      else await ctx.db.insert("counters", { name: "invoice", value: value + 1 });
      return number;
    }
  }
  throw new Error("Could not allocate an invoice number");
}

/**
 * Recompute status after any money movement on an invoice. A zero balance
 * closes it (paid, or written_off if a write-off was needed) and resolves its
 * open collection tasks.
 */
export async function settleInvoice(
  ctx: MutationCtx,
  invoiceId: Id<"invoices">,
  cashDate: number,
  actor: string,
  traceId: string,
): Promise<Doc<"invoices">> {
  const inv = (await ctx.db.get(invoiceId))!;
  const balance = invoiceBalance(inv);
  if (balance > 0) {
    const status =
      inv.status === "disputed" ? "disputed" : inv.paidMinor > 0 ? "partially_paid" : "open";
    if (status !== inv.status) await ctx.db.patch(invoiceId, { status });
    return (await ctx.db.get(invoiceId))!;
  }
  if (inv.status === "paid" || inv.status === "written_off") return inv;

  const status = inv.writtenOffMinor > 0 ? ("written_off" as const) : ("paid" as const);
  await ctx.db.patch(invoiceId, {
    status,
    paidAt: status === "paid" ? cashDate : inv.paidAt,
  });
  await recordAudit(ctx, {
    workspaceId: inv.workspaceId,
    traceId,
    actor,
    type: status === "paid" ? "invoice.paid" : "invoice.written_off",
    subjectId: invoiceId,
    reason: `${inv.number} closed (${status})`,
    data: {
      paidMinor: inv.paidMinor,
      adjustmentMinor: inv.adjustmentMinor,
      writtenOffMinor: inv.writtenOffMinor,
    },
  });

  const tasks = await ctx.db
    .query("collectionTasks")
    .withIndex("by_invoice", (q) => q.eq("invoiceId", invoiceId))
    .take(20);
  for (const task of tasks) {
    if (task.status === "resolved") continue;
    await ctx.db.patch(task._id, {
      status: "resolved",
      resolution: `Invoice ${status}; no further follow-up.`,
    });
    await recordAudit(ctx, {
      workspaceId: inv.workspaceId,
      traceId,
      actor,
      type: "collection.resolved",
      subjectId: task._id,
      reason: `${inv.number} ${status}`,
    });
  }
  return (await ctx.db.get(invoiceId))!;
}

export async function openFinanceException(
  ctx: MutationCtx,
  fields: {
    workspaceId: Id<"workspaces"> | undefined;
    kind: FinanceExceptionKind;
    expectedMinor: number;
    observedMinor: number;
    evidence: string;
    nextAction: string;
    invoiceId?: Id<"invoices">;
    bankTransactionId?: Id<"bankTransactions">;
    advertiserId?: Id<"advertisers">;
  },
  actor: string,
  traceId: string,
): Promise<Id<"financeExceptions">> {
  const id = await ctx.db.insert("financeExceptions", { ...fields, status: "open" });
  await recordAudit(ctx, {
    workspaceId: fields.workspaceId,
    traceId,
    actor,
    type: "finance.exception_opened",
    subjectId: id,
    reason: fields.evidence.slice(0, 500),
    data: {
      kind: fields.kind,
      expectedMinor: fields.expectedMinor,
      observedMinor: fields.observedMinor,
      invoiceId: fields.invoiceId ?? null,
      bankTransactionId: fields.bankTransactionId ?? null,
    },
  });
  return id;
}

/** Resolve an exception. Only called while executing a controller-approved approval. */
export async function resolveFinanceException(
  ctx: MutationCtx,
  id: Id<"financeExceptions">,
  resolution: string,
  resolvedBy: string,
  traceId: string,
): Promise<void> {
  const ex = await ctx.db.get(id);
  if (!ex || ex.status !== "open") return;
  await ctx.db.patch(id, { status: "resolved", resolution, resolvedBy, resolvedAt: Date.now() });
  await recordAudit(ctx, {
    workspaceId: ex.workspaceId,
    traceId,
    actor: resolvedBy,
    type: "finance.exception_resolved",
    subjectId: id,
    reason: resolution,
    data: { kind: ex.kind },
  });
}

export const MAX_ACTOR_LENGTH = 64;

export function assertActor(name: string, value: string): string {
  const v = value.trim();
  if (v.length === 0 || v.length > MAX_ACTOR_LENGTH) {
    throw new ConvexError({ code: "INVALID_INPUT", message: `${name} must be 1..${MAX_ACTOR_LENGTH} characters` });
  }
  return v;
}

/**
 * File an approval request (anyone, including agents, may request).
 * Idempotent: an identical pending request (action + subject) is returned instead.
 */
export async function createApproval(
  ctx: MutationCtx,
  fields: {
    workspaceId: Id<"workspaces"> | undefined;
    action: ApprovalAction;
    subjectKind: ApprovalSubjectKind;
    subjectId: string;
    amountMinor: number;
    requestedBy: string;
    reason: string;
    invoiceId?: Id<"invoices">;
    financeExceptionId?: Id<"financeExceptions">;
    collectionTaskId?: Id<"collectionTasks">;
  },
  traceId: string,
): Promise<{ approvalId: Id<"approvals">; replayed: boolean }> {
  const requestedBy = assertActor("requestedBy", fields.requestedBy);
  const reason = fields.reason.trim().slice(0, 1000);
  if (reason.length === 0) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "reason is required" });
  }
  if (!Number.isSafeInteger(fields.amountMinor) || fields.amountMinor <= 0) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "amountMinor must be a positive integer" });
  }
  const existing = await ctx.db
    .query("approvals")
    .withIndex("by_subject", (q) => q.eq("subjectId", fields.subjectId))
    .take(50);
  const dup = existing.find(
    (a) =>
      a.status === "pending" &&
      a.action === fields.action &&
      a.invoiceId === fields.invoiceId,
  );
  if (dup) return { approvalId: dup._id, replayed: true };

  const approvalId = await ctx.db.insert("approvals", {
    ...fields,
    requestedBy,
    reason,
    status: "pending",
  });
  await recordAudit(ctx, {
    workspaceId: fields.workspaceId,
    traceId,
    actor: requestedBy,
    type: "approval.requested",
    subjectId: approvalId,
    reason: `${fields.action} ${fields.subjectKind} ${fields.subjectId} for ${fields.amountMinor} minor units: ${reason}`.slice(0, 1000),
    data: {
      action: fields.action,
      subjectId: fields.subjectId,
      amountMinor: fields.amountMinor,
      financeExceptionId: fields.financeExceptionId ?? null,
    },
  });
  return { approvalId, replayed: false };
}
