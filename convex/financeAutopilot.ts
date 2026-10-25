import { v } from "convex/values";
import { internalMutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auditEventType } from "./schema";
import { AR_AGENT, MAX_LINES_PER_RUN, reconciliationSummary, runReconciliationBatch } from "./reconciliation";
import { resolveWorkspace } from "./lib/tenancy";

/**
 * Finance autopilot (ADR 0007 spirit): the AR clerk and the collections seat
 * run on their own. Nobody presses a button for cash to be applied.
 *
 *  - New bank lines (`bank.ingest`) schedule an AR run for that workspace at
 *    once, debounced: a burst of ingests yields one run, and runs are at
 *    least AR_DEBOUNCE_MS apart (a late arrival gets one trailing run).
 *  - `tick` (cron, every 5 min) picks up stragglers (unmatched lines that
 *    arrived over a minute ago) and re-plans collections when invoices have
 *    just become overdue.
 *
 * Guard state lives in the `counters` table (name -> number), one row per
 * workspace per key, so no schema change is needed.
 */

export const AR_DEBOUNCE_MS = 30_000;
export const STRAGGLER_AGE_MS = 60_000;
export const TICK_INTERVAL_MS = 5 * 60_000;
/** A pending marker older than this is assumed lost (e.g. the run threw). */
export const STALE_PENDING_MS = 2 * 60_000;
const MAX_WORKSPACES_PER_TICK = 50;
const MAX_OVERDUE_LOOKBACK_MS = 24 * 60 * 60_000;
const ACTIVITY_SCAN = 300;
const ACTIVITY_MAX = 12;

export const TRIGGER_NEW_LINES = "new bank lines arrived";
export const TRIGGER_STRAGGLERS = "unmatched bank lines waiting over a minute";
const TRIGGER_MORE = "more bank lines waiting after a full batch";

const KEY = {
  pendingAt: (ws: Id<"workspaces">) => `financeAutopilot:arPendingAt:${ws}`,
  lastRunAt: (ws: Id<"workspaces">) => `financeAutopilot:arLastRunAt:${ws}`,
  lastProcessed: (ws: Id<"workspaces">) => `financeAutopilot:arLastProcessed:${ws}`,
  lastTickAt: "financeAutopilot:lastTickAt",
};

async function readCounter(ctx: QueryCtx, name: string): Promise<number | null> {
  const row = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  return row ? row.value : null;
}

async function writeCounter(ctx: MutationCtx, name: string, value: number): Promise<void> {
  const row = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  if (row) {
    if (row.value !== value) await ctx.db.patch(row._id, { value });
  } else {
    await ctx.db.insert("counters", { name, value });
  }
}

/**
 * Ask the AR clerk to run for this workspace. Debounced: if a run is already
 * pending it will see the new lines, so nothing is scheduled; otherwise the
 * run goes now, or AR_DEBOUNCE_MS after the previous run started.
 */
export async function requestArRun(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  trigger: string,
): Promise<{ scheduled: boolean; runAt: number }> {
  const now = Date.now();
  const pendingAt = (await readCounter(ctx, KEY.pendingAt(workspaceId))) ?? 0;
  if (pendingAt > 0 && pendingAt > now - STALE_PENDING_MS) {
    return { scheduled: false, runAt: pendingAt };
  }
  const lastRunAt = (await readCounter(ctx, KEY.lastRunAt(workspaceId))) ?? 0;
  const runAt = Math.max(now, lastRunAt + AR_DEBOUNCE_MS);
  await ctx.scheduler.runAfter(runAt - now, internal.financeAutopilot.runArClerk, { workspaceId, trigger });
  await writeCounter(ctx, KEY.pendingAt(workspaceId), runAt);
  return { scheduled: true, runAt };
}

/** Record that the AR clerk ran (automatic or "Reconcile now"), for the status line. */
export async function noteArRun(ctx: MutationCtx, workspaceId: Id<"workspaces">, processed: number): Promise<void> {
  await writeCounter(ctx, KEY.lastRunAt(workspaceId), Date.now());
  await writeCounter(ctx, KEY.lastProcessed(workspaceId), processed);
}

/** Scheduled AR clerk run for one workspace (see requestArRun). */
export const runArClerk = internalMutation({
  args: { workspaceId: v.id("workspaces"), trigger: v.string() },
  returns: reconciliationSummary,
  handler: async (ctx, args) => {
    await writeCounter(ctx, KEY.pendingAt(args.workspaceId), 0);
    const summary = await runReconciliationBatch(ctx, args.workspaceId, AR_AGENT, args.trigger.slice(0, 200));
    await noteArRun(ctx, args.workspaceId, summary.processed);
    // A full batch means more lines may be waiting: chain one more run.
    if (summary.processed >= MAX_LINES_PER_RUN) {
      await requestArRun(ctx, args.workspaceId, TRIGGER_MORE);
    }
    return summary;
  },
});

/**
 * Cron (every 5 min): per workspace, reconcile stragglers and re-plan
 * collections for invoices that became overdue since the last tick.
 * Only schedules work; bounded reads per workspace.
 */
export const tick = internalMutation({
  args: {},
  returns: v.object({
    workspacesChecked: v.number(),
    arRunsScheduled: v.number(),
    collectionsReplanned: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const lastTickAt = await readCounter(ctx, KEY.lastTickAt);
    const overdueSince =
      lastTickAt === null ? now - MAX_OVERDUE_LOOKBACK_MS : Math.max(lastTickAt, now - MAX_OVERDUE_LOOKBACK_MS);
    let arRunsScheduled = 0;
    let collectionsReplanned = 0;

    const workspaces = await ctx.db.query("workspaces").take(MAX_WORKSPACES_PER_TICK);
    for (const ws of workspaces) {
      // Stragglers: unmatched lines that arrived over a minute ago.
      const unmatched = await ctx.db
        .query("bankTransactions")
        .withIndex("by_workspace_and_status_and_postedAt", (q) =>
          q.eq("workspaceId", ws._id).eq("status", "unmatched"),
        )
        .take(MAX_LINES_PER_RUN);
      if (unmatched.some((l) => l._creationTime <= now - STRAGGLER_AGE_MS)) {
        const r = await requestArRun(ctx, ws._id, TRIGGER_STRAGGLERS);
        if (r.scheduled) arRunsScheduled++;
      }

      // Invoices that crossed their due date since the last tick.
      let newlyOverdue = false;
      for (const status of ["open", "partially_paid"] as const) {
        const hit = await ctx.db
          .query("invoices")
          .withIndex("by_workspace_and_status_and_dueAt", (q) =>
            q.eq("workspaceId", ws._id).eq("status", status).gt("dueAt", overdueSince).lte("dueAt", now),
          )
          .first();
        if (hit) {
          newlyOverdue = true;
          break;
        }
      }
      if (newlyOverdue) {
        await ctx.scheduler.runAfter(0, internal.collections.plan, { workspaceId: ws._id });
        collectionsReplanned++;
      }
    }

    await writeCounter(ctx, KEY.lastTickAt, now);
    return { workspacesChecked: workspaces.length, arRunsScheduled, collectionsReplanned };
  },
});

const ACTIVITY_TYPES = new Set<string>([
  "reconciliation.applied",
  "reconciliation.needs_review",
  "reconciliation.handoff",
  "collection.planned",
]);

/**
 * Autopilot status for the Finance page: when the AR clerk last ran, how
 * many lines it processed, what's pending, and its recent activity.
 * Times are raw; the client renders "ago" / "next check".
 */
export const status = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({
    lastRunAt: v.union(v.number(), v.null()),
    lastProcessed: v.union(v.number(), v.null()),
    pendingRunAt: v.union(v.number(), v.null()),
    lastTickAt: v.union(v.number(), v.null()),
    tickIntervalMs: v.number(),
    stalePendingMs: v.number(),
    canReconcileNow: v.boolean(),
    activity: v.array(
      v.object({
        _id: v.id("auditEvents"),
        _creationTime: v.number(),
        actor: v.string(),
        type: auditEventType,
        reason: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const pendingAt = await readCounter(ctx, KEY.pendingAt(me.workspaceId));
    const recent = await ctx.db
      .query("auditEvents")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .order("desc")
      .take(ACTIVITY_SCAN);
    return {
      lastRunAt: await readCounter(ctx, KEY.lastRunAt(me.workspaceId)),
      lastProcessed: await readCounter(ctx, KEY.lastProcessed(me.workspaceId)),
      pendingRunAt: pendingAt && pendingAt > 0 ? pendingAt : null,
      lastTickAt: await readCounter(ctx, KEY.lastTickAt),
      tickIntervalMs: TICK_INTERVAL_MS,
      stalePendingMs: STALE_PENDING_MS,
      canReconcileNow: me.role === "owner",
      activity: recent
        .filter((e) => ACTIVITY_TYPES.has(e.type))
        .slice(0, ACTIVITY_MAX)
        .map((e) => ({ _id: e._id, _creationTime: e._creationTime, actor: e.actor, type: e.type, reason: e.reason })),
    };
  },
});
