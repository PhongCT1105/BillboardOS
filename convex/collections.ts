import { v } from "convex/values";
import { internalMutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { collectionTaskStatus, collectionTone, invoiceStatus } from "./schema";
import { recordAudit } from "./lib/audit";
import { chooseTone, TONE_RANK, type HistoryItem } from "./lib/collections";
import { createApproval, invoiceBalance } from "./lib/finance";
import { usd } from "./lib/reconcile";
import { resolveWorkspace } from "./lib/tenancy";

/** The collections seat. Plans follow-ups; never sends, never approves. */
export const COLLECTIONS_AGENT = "agent:collections";
const MAX_OVERDUE_PER_STATUS = 100;
const MAX_HISTORY = 50;

async function overdueInvoices(ctx: QueryCtx, workspaceId: Id<"workspaces">, asOf: number): Promise<Doc<"invoices">[]> {
  const out: Doc<"invoices">[] = [];
  for (const status of ["open", "partially_paid"] as const) {
    out.push(
      ...(await ctx.db
        .query("invoices")
        .withIndex("by_workspace_and_status_and_dueAt", (q) =>
          q.eq("workspaceId", workspaceId).eq("status", status).lt("dueAt", asOf),
        )
        .take(MAX_OVERDUE_PER_STATUS)),
    );
  }
  return out.filter((i) => invoiceBalance(i) > 0).sort((a, b) => a.dueAt - b.dueAt);
}

async function historyFor(ctx: QueryCtx, inv: Doc<"invoices">): Promise<HistoryItem[]> {
  const rows = await ctx.db
    .query("invoices")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", inv.advertiserId))
    .take(MAX_HISTORY);
  // History with THIS host only: another host's invoices are not ours to cite.
  return rows
    .filter((r) => r._id !== inv._id && r.workspaceId === inv.workspaceId)
    .map((r) => ({ number: r.number, dueAt: r.dueAt, paidAt: r.paidAt ?? null }));
}

/** Overdue invoices with the tone the collections seat would use (read-only preview). */
export const dueForFollowUp = query({
  args: { asOf: v.optional(v.number()), workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(
    v.object({
      invoiceId: v.id("invoices"),
      number: v.string(),
      advertiserId: v.id("advertisers"),
      advertiserName: v.string(),
      balanceMinor: v.number(),
      dueAt: v.number(),
      daysOverdue: v.number(),
      priorLateCount: v.number(),
      proposedTone: v.union(collectionTone, v.null()),
      reason: v.string(),
      hasOpenTask: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const asOf = args.asOf ?? Date.now();
    const rows = [];
    for (const inv of await overdueInvoices(ctx, me.workspaceId, asOf)) {
      const choice = chooseTone({
        invoiceNumber: inv.number,
        dueAt: inv.dueAt,
        asOf,
        history: await historyFor(ctx, inv),
      });
      const advertiser = await ctx.db.get(inv.advertiserId);
      const tasks = await ctx.db
        .query("collectionTasks")
        .withIndex("by_invoice", (q) => q.eq("invoiceId", inv._id))
        .take(20);
      rows.push({
        invoiceId: inv._id,
        number: inv.number,
        advertiserId: inv.advertiserId,
        advertiserName: advertiser?.displayName ?? "Unknown advertiser",
        balanceMinor: invoiceBalance(inv),
        dueAt: inv.dueAt,
        daysOverdue: choice.daysOverdue,
        priorLateCount: choice.priorLateCount,
        proposedTone: choice.tone,
        reason: choice.reason,
        hasOpenTask: tasks.some((t) => t.status !== "resolved"),
      });
    }
    return rows;
  },
});

/**
 * Plan follow-ups for overdue invoices (cron-callable, idempotent). Writes a
 * collection task per invoice when the tone is new or firmer than any open
 * task; escalations become a controller approval request, never an action.
 */
export const plan = internalMutation({
  args: { asOf: v.optional(v.number()), workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({
    examined: v.number(),
    tasksCreated: v.number(),
    escalationsRequested: v.number(),
  }),
  handler: async (ctx, args) => {
    const asOf = args.asOf ?? Date.now();
    let tasksCreated = 0;
    let escalationsRequested = 0;
    const workspaceIds = args.workspaceId
      ? [args.workspaceId]
      : (await ctx.db.query("workspaces").take(20)).map((w) => w._id);
    const invoices: Doc<"invoices">[] = [];
    for (const id of workspaceIds) invoices.push(...(await overdueInvoices(ctx, id, asOf)));
    for (const inv of invoices) {
      const choice = chooseTone({
        invoiceNumber: inv.number,
        dueAt: inv.dueAt,
        asOf,
        history: await historyFor(ctx, inv),
      });
      if (!choice.tone) continue;
      const tasks = await ctx.db
        .query("collectionTasks")
        .withIndex("by_invoice", (q) => q.eq("invoiceId", inv._id))
        .take(20);
      let tone = choice.tone;
      let reason = choice.reason;
      // The controller has already been asked once; don't ask again, keep chasing firmly.
      if (tone === "escalate_to_controller" && tasks.some((t) => t.tone === tone)) {
        tone = "firm";
        reason = `${choice.reason} Escalation already raised with the controller; continuing firm follow-up.`;
      }
      const open = tasks.filter((t) => t.status !== "resolved");
      if (open.some((t) => TONE_RANK[t.tone] >= TONE_RANK[tone])) continue;

      const balanceMinor = invoiceBalance(inv);
      const taskId: Id<"collectionTasks"> = await ctx.db.insert("collectionTasks", {
        workspaceId: inv.workspaceId,
        invoiceId: inv._id,
        advertiserId: inv.advertiserId,
        tone,
        reason: reason.slice(0, 1000),
        status: "planned",
        daysOverdue: choice.daysOverdue,
        balanceMinor,
        plannedAt: asOf,
      });
      tasksCreated++;
      const traceId = `invoice:${inv.number}`;
      await recordAudit(ctx, {
        workspaceId: inv.workspaceId,
        traceId,
        actor: COLLECTIONS_AGENT,
        type: "collection.planned",
        subjectId: taskId,
        reason: `${tone} follow-up for ${inv.number} (${usd(balanceMinor)}): ${reason}`.slice(0, 1000),
        data: { invoiceId: inv._id, tone, daysOverdue: choice.daysOverdue, priorLateCount: choice.priorLateCount },
      });
      if (tone === "escalate_to_controller") {
        const r = await createApproval(
          ctx,
          {
            workspaceId: inv.workspaceId,
            action: "escalate_collection",
            subjectKind: "invoice",
            subjectId: inv._id,
            amountMinor: balanceMinor,
            requestedBy: COLLECTIONS_AGENT,
            reason,
            collectionTaskId: taskId,
          },
          traceId,
        );
        await ctx.db.patch(taskId, { approvalId: r.approvalId });
        escalationsRequested++;
      }
    }
    return { examined: invoices.length, tasksCreated, escalationsRequested };
  },
});

/** Collection tasks, newest first (max 50), optionally by status. */
export const tasks = query({
  args: { status: v.optional(collectionTaskStatus), workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(
    v.object({
      _id: v.id("collectionTasks"),
      _creationTime: v.number(),
      invoiceId: v.id("invoices"),
      invoiceNumber: v.string(),
      invoiceStatus,
      advertiserId: v.id("advertisers"),
      advertiserName: v.string(),
      tone: collectionTone,
      reason: v.string(),
      status: collectionTaskStatus,
      daysOverdue: v.number(),
      balanceMinor: v.number(),
      plannedAt: v.number(),
      approvalId: v.optional(v.id("approvals")),
      resolution: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const status = args.status;
    const rows = status
      ? await ctx.db
          .query("collectionTasks")
          .withIndex("by_workspace_and_status", (q) => q.eq("workspaceId", me.workspaceId).eq("status", status))
          .order("desc")
          .take(50)
      : await ctx.db
          .query("collectionTasks")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
          .order("desc")
          .take(50);
    const out = [];
    for (const t of rows) {
      const inv = await ctx.db.get(t.invoiceId);
      const advertiser = await ctx.db.get(t.advertiserId);
      if (!inv) continue;
      out.push({
        _id: t._id,
        _creationTime: t._creationTime,
        invoiceId: t.invoiceId,
        invoiceNumber: inv.number,
        invoiceStatus: inv.status,
        advertiserId: t.advertiserId,
        advertiserName: advertiser?.displayName ?? "Unknown advertiser",
        tone: t.tone,
        reason: t.reason,
        status: t.status,
        daysOverdue: t.daysOverdue,
        balanceMinor: t.balanceMinor,
        plannedAt: t.plannedAt,
        approvalId: t.approvalId,
        resolution: t.resolution,
      });
    }
    return out;
  },
});
