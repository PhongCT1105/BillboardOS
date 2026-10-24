import { v } from "convex/values";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { ensureDemoWorkspace } from "./seed";

/**
 * ADR 0004 tenancy migration (bounded, idempotent):
 *  1. `tenancy`: ensure the "Moscone Media" workspace; legacy operators become
 *     its owners (with host profiles). Advertisers stay member-less companies.
 *  2. `backfillPage`: per table, one page at a time, set `workspaceId` on rows
 *     that lack it, derived from the record (billboard -> workspace, hold ->
 *     workspace, ...), falling back to Moscone Media for single-tenant history.
 *  3. `run` (action): does both until every table reports done.
 * Re-running patches nothing: rows that already have a workspace are skipped.
 */

export const TENANT_TABLES = [
  "billboards",
  "slots",
  "quotes",
  "holds",
  "bookings",
  "payments",
  "auctions",
  "events",
  "priceHistory",
  "playbackEvents",
  "audienceAggregates",
  "invoices",
  "bankTransactions",
  "financeExceptions",
  "approvals",
  "collectionTasks",
  "auditEvents",
] as const;
type TenantTable = (typeof TENANT_TABLES)[number];

/**
 * Audit events that belong to no host workspace by design (customer-side or
 * platform-level: company valuation, company/campaign creation, creative
 * upload). The backfill leaves them unassigned.
 */
export const PLATFORM_AUDIT_TYPES = new Set([
  "valuation.assessed",
  "valuation.failed",
  "company.created",
  "campaign.created",
  "creative.attached",
]);

const tenantTable = v.union(...TENANT_TABLES.map((t) => v.literal(t)));
const PAGE_SIZE = 200;

async function ofBillboard(ctx: MutationCtx, billboardId: Id<"billboards"> | undefined, fallback: Id<"workspaces">) {
  if (!billboardId) return fallback;
  return (await ctx.db.get(billboardId))?.workspaceId ?? fallback;
}

async function ofHold(ctx: MutationCtx, holdId: Id<"holds"> | undefined, fallback: Id<"workspaces">) {
  if (!holdId) return fallback;
  const hold = await ctx.db.get(holdId);
  return hold?.workspaceId ?? (await ofBillboard(ctx, hold?.billboardId, fallback));
}

async function ofInvoice(ctx: MutationCtx, invoiceId: Id<"invoices"> | undefined, fallback: Id<"workspaces">) {
  if (!invoiceId) return fallback;
  const invoice = await ctx.db.get(invoiceId);
  if (!invoice) return fallback;
  if (invoice.workspaceId) return invoice.workspaceId;
  const booking = invoice.bookingId ? await ctx.db.get(invoice.bookingId) : null;
  return await ofBillboard(ctx, booking?.billboardId, fallback);
}

/** Workspace a legacy row belongs to, derived from what it points at. */
async function deriveWorkspace(
  ctx: MutationCtx,
  table: TenantTable,
  doc: Record<string, unknown>,
  fallback: Id<"workspaces">,
): Promise<Id<"workspaces">> {
  switch (table) {
    case "billboards":
    case "bankTransactions":
    case "auditEvents":
      return fallback;
    case "slots":
    case "quotes":
    case "holds":
    case "bookings":
    case "auctions":
    case "events":
    case "priceHistory":
    case "playbackEvents":
    case "audienceAggregates":
      return await ofBillboard(ctx, doc.billboardId as Id<"billboards">, fallback);
    case "payments":
      return await ofHold(ctx, doc.holdId as Id<"holds">, fallback);
    case "invoices": {
      const booking = doc.bookingId ? await ctx.db.get(doc.bookingId as Id<"bookings">) : null;
      return booking?.workspaceId ?? (await ofBillboard(ctx, booking?.billboardId, fallback));
    }
    case "financeExceptions": {
      const ex = doc as Doc<"financeExceptions">;
      if (ex.billboardId) return await ofBillboard(ctx, ex.billboardId, fallback);
      if (ex.holdId) return await ofHold(ctx, ex.holdId, fallback);
      if (ex.bankTransactionId) return (await ctx.db.get(ex.bankTransactionId))?.workspaceId ?? fallback;
      return await ofInvoice(ctx, ex.invoiceId, fallback);
    }
    case "approvals": {
      const a = doc as Doc<"approvals">;
      const invoiceId = ctx.db.normalizeId("invoices", a.subjectId);
      if (invoiceId) return await ofInvoice(ctx, invoiceId, fallback);
      const paymentId = ctx.db.normalizeId("payments", a.subjectId);
      if (paymentId) return (await ctx.db.get(paymentId))?.workspaceId ?? fallback;
      const bankId = ctx.db.normalizeId("bankTransactions", a.subjectId);
      if (bankId) return (await ctx.db.get(bankId))?.workspaceId ?? fallback;
      return fallback;
    }
    case "collectionTasks":
      return await ofInvoice(ctx, (doc as Doc<"collectionTasks">).invoiceId, fallback);
  }
}

/** Step 1: demo workspace + legacy operators -> owners. Idempotent. */
export const tenancy = internalMutation({
  args: {},
  returns: v.object({ workspaceId: v.id("workspaces"), ownersAdded: v.number() }),
  handler: async (ctx) => {
    const workspaceId = await ensureDemoWorkspace(ctx);
    let ownersAdded = 0;
    for (const op of await ctx.db.query("operators").take(100)) {
      const existing = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", op.userId))
        .unique();
      if (!existing) {
        await ctx.db.insert("workspaceMembers", { workspaceId, userId: op.userId, email: op.email, role: "owner" });
        ownersAdded++;
      }
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_userId", (q) => q.eq("userId", op.userId))
        .unique();
      if (!profile) await ctx.db.insert("profiles", { userId: op.userId, accountType: "host", activeWorkspaceId: workspaceId });
      const workspace = (await ctx.db.get(workspaceId))!;
      if (!workspace.ownerUserId) await ctx.db.patch(workspaceId, { ownerUserId: op.userId });
    }
    return { workspaceId, ownersAdded };
  },
});

/** Step 2: one page of one table. */
export const backfillPage = internalMutation({
  args: { table: tenantTable, cursor: v.union(v.string(), v.null()) },
  returns: v.object({ patched: v.number(), scanned: v.number(), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    const fallback = await ensureDemoWorkspace(ctx);
    const page = await ctx.db.query(args.table).paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
    let patched = 0;
    for (const doc of page.page) {
      if ((doc as { workspaceId?: Id<"workspaces"> }).workspaceId) continue;
      if (args.table === "auditEvents" && PLATFORM_AUDIT_TYPES.has((doc as Doc<"auditEvents">).type)) continue;
      const workspaceId = await deriveWorkspace(ctx, args.table, doc as Record<string, unknown>, fallback);
      await ctx.db.patch(doc._id, { workspaceId } as never);
      patched++;
    }
    return { patched, scanned: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const recordRun = internalMutation({
  args: { summary: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordAudit(ctx, {
      workspaceId: await ensureDemoWorkspace(ctx),
      traceId: "migration:tenancy",
      actor: "system:migration",
      type: "tenancy.migrated",
      subjectId: "tenancy",
      reason: args.summary.slice(0, 1000),
    });
    return null;
  },
});

/** Step 3: run everything (`npx convex run migrations:run`). Safe to re-run. */
export const run = internalAction({
  args: {},
  returns: v.object({
    workspaceId: v.id("workspaces"),
    ownersAdded: v.number(),
    tables: v.array(v.object({ table: v.string(), scanned: v.number(), patched: v.number() })),
  }),
  handler: async (ctx): Promise<{
    workspaceId: Id<"workspaces">;
    ownersAdded: number;
    tables: { table: string; scanned: number; patched: number }[];
  }> => {
    const step1: { workspaceId: Id<"workspaces">; ownersAdded: number } = await ctx.runMutation(
      internal.migrations.tenancy,
      {},
    );
    const { workspaceId, ownersAdded } = step1;
    const tables: { table: string; scanned: number; patched: number }[] = [];
    for (const table of TENANT_TABLES) {
      let cursor: string | null = null;
      let scanned = 0;
      let patched = 0;
      for (;;) {
        const r: { patched: number; scanned: number; isDone: boolean; continueCursor: string } = await ctx.runMutation(
          internal.migrations.backfillPage,
          { table, cursor },
        );
        scanned += r.scanned;
        patched += r.patched;
        if (r.isDone) break;
        cursor = r.continueCursor;
      }
      tables.push({ table, scanned, patched });
    }
    const total = tables.reduce((s, t) => s + t.patched, 0);
    await ctx.runMutation(internal.migrations.recordRun, {
      summary: `Tenancy migration: ${total} row(s) assigned a workspace across ${tables.length} tables; ${ownersAdded} legacy operator(s) made owners.`,
    });
    return { workspaceId, ownersAdded, tables };
  },
});
