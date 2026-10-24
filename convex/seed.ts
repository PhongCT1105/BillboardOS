import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { ensureUpcomingSlots } from "./lib/inventory";
import { ingestBankLines } from "./bank";
import { endHold } from "./holds";
import { settleInvoice } from "./lib/finance";
import {
  FIXTURE_ADVERTISERS,
  FIXTURE_BANK_LINES,
  FIXTURE_INVOICES,
} from "./fixtures/financeFixture";

const BILLBOARD_NAME = "Moscone West Screen";

/**
 * Idempotent demo seed (`npm run seed`). Creates, only if missing:
 * one San Francisco billboard, 15-minute slots for the next 12 hours (topped
 * up on every run), two advertisers, and one active campaign.
 */
export const demo = internalMutation({
  args: {},
  returns: v.object({
    created: v.boolean(),
    billboardId: v.id("billboards"),
    advertiserIds: v.array(v.id("advertisers")),
    campaignId: v.id("campaigns"),
    slotsCreated: v.number(),
  }),
  handler: async (ctx) => {
    let created = false;

    let billboard = await ctx.db
      .query("billboards")
      .withIndex("by_name", (q) => q.eq("name", BILLBOARD_NAME))
      .first();
    let slotsCreated = 0;
    if (!billboard) {
      created = true;
      const billboardId = await ctx.db.insert("billboards", {
        name: BILLBOARD_NAME,
        city: "San Francisco",
        locationLabel: "Moscone Center West, 800 Howard St, San Francisco, CA",
        utcOffsetMinutes: -420, // PDT (Cal Hacks weekend)
        reserveFloorMinor: 2000, // $20
        baseRateMinor: 4000, // $40
        deviceStatus: "online",
      });
      billboard = (await ctx.db.get(billboardId))!;
    }
    // Rolling 12h of 15-minute slots (same helper the cron uses).
    slotsCreated = await ensureUpcomingSlots(ctx, billboard._id, Date.now());
    if (slotsCreated > 0) created = true;

    const advertiserSpecs = [
      { displayName: "Golden Gate Coffee Co.", paymentTerms: "prepay" as const },
      { displayName: "Bay Robotics", paymentTerms: "net15" as const },
    ];
    const advertiserIds: Id<"advertisers">[] = [];
    for (const spec of advertiserSpecs) {
      const existing = await ctx.db
        .query("advertisers")
        .withIndex("by_displayName", (q) => q.eq("displayName", spec.displayName))
        .first();
      if (existing) {
        advertiserIds.push(existing._id);
      } else {
        created = true;
        advertiserIds.push(await ctx.db.insert("advertisers", spec));
      }
    }

    let campaign = await ctx.db
      .query("campaigns")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserIds[0]))
      .first();
    if (!campaign) {
      created = true;
      const campaignId = await ctx.db.insert("campaigns", {
        advertiserId: advertiserIds[0],
        brief: "Morning coffee promo for Cal Hacks attendees near Moscone West; 2-4 slots, 7-10am.",
        targetCity: "San Francisco",
        budgetMinor: 30000, // $300
        currency: "USD",
        status: "active",
        creativeStatus: "none",
      });
      campaign = (await ctx.db.get(campaignId))!;
    }

    if (created) {
      await recordAudit(ctx, {
        traceId: "seed:demo",
        actor: "system",
        type: "seed.completed",
        subjectId: billboard._id,
        reason: `Seeded demo inventory (${slotsCreated} new slots)`,
        data: { campaignId: campaign._id, slotsCreated },
      });
    }

    return {
      created,
      billboardId: billboard._id,
      advertiserIds,
      campaignId: campaign._id,
      slotsCreated,
    };
  },
});

/**
 * Create the finance fixture if missing. With `restoreInvoices`, existing
 * fixture invoices are also put back to their seeded state.
 */
async function seedFinanceFixture(ctx: MutationCtx, restoreInvoices: boolean) {
  let advertisersCreated = 0;
  const ids = new Map<string, Id<"advertisers">>();
  for (const spec of FIXTURE_ADVERTISERS) {
    const existing = await ctx.db
      .query("advertisers")
      .withIndex("by_displayName", (q) => q.eq("displayName", spec.displayName))
      .first();
    if (existing) {
      ids.set(spec.key, existing._id);
      if (!existing.payerAliases) {
        await ctx.db.patch(existing._id, { payerAliases: spec.payerAliases });
      }
      continue;
    }
    ids.set(
      spec.key,
      await ctx.db.insert("advertisers", {
        displayName: spec.displayName,
        paymentTerms: spec.paymentTerms,
        payerAliases: spec.payerAliases,
      }),
    );
    advertisersCreated++;
  }

  let invoicesCreated = 0;
  let invoicesRestored = 0;
  for (const inv of FIXTURE_INVOICES) {
    const paid = inv.paidAt !== undefined;
    const seeded = {
      number: inv.number,
      advertiserId: ids.get(inv.advertiser)!,
      description: inv.description,
      amountMinor: inv.amountMinor,
      currency: "USD" as const,
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      status: paid ? ("paid" as const) : ("open" as const),
      paidMinor: paid ? inv.amountMinor : 0,
      adjustmentMinor: 0,
      writtenOffMinor: 0,
      paidAt: inv.paidAt,
      source: "fixture" as const,
    };
    const existing = await ctx.db
      .query("invoices")
      .withIndex("by_number", (q) => q.eq("number", inv.number))
      .first();
    if (!existing) {
      await ctx.db.insert("invoices", seeded);
      invoicesCreated++;
    } else if (restoreInvoices && existing.source === "fixture") {
      await ctx.db.replace(existing._id, seeded);
      invoicesRestored++;
    }
  }

  const bank = await ingestBankLines(ctx, FIXTURE_BANK_LINES, "system:fixture");
  return { advertisersCreated, invoicesCreated, invoicesRestored, bank };
}

/**
 * Idempotent finance fixture (`npx convex run seed:finance`): three net15
 * advertisers with Aug-Oct 2026 invoice history and a bank feed with planted
 * errors. Everything is labeled source "fixture" (simulated). Reconciliation
 * is NOT run here; press "Run reconciliation" (finance.runReconciliation).
 * Expected outcomes: convex/fixtures/financeAnswerKey.ts.
 */
export const finance = internalMutation({
  args: {},
  returns: v.object({
    advertisersCreated: v.number(),
    invoicesCreated: v.number(),
    bankLinesInserted: v.number(),
    bankLinesDuplicate: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const r = await seedFinanceFixture(ctx, false);
    if (r.advertisersCreated + r.invoicesCreated + r.bank.inserted.length > 0) {
      await recordAudit(ctx, {
        traceId: "seed:finance",
        actor: "system",
        type: "seed.completed",
        subjectId: "finance-fixture",
        reason: `Seeded SIMULATED finance fixture: ${r.advertisersCreated} advertisers, ${r.invoicesCreated} invoices, ${r.bank.inserted.length} bank lines`,
        data: { duplicates: r.bank.duplicates },
      });
    }
    return {
      advertisersCreated: r.advertisersCreated,
      invoicesCreated: r.invoicesCreated,
      bankLinesInserted: r.bank.inserted.length,
      bankLinesDuplicate: r.bank.duplicates,
    };
  },
});

const MAX_FIXTURE_BANK_LINES = 200;

/**
 * Rehearsal reset for the "Run reconciliation" moment
 * (`npx convex run seed:resetFinanceDemo`). Removes everything DERIVED from
 * fixture data (source "fixture" bank lines incl. judge scenario lines, their
 * applications, AR exceptions, approvals and fixture-invoice collection
 * tasks), restores fixture invoices to their seeded state, and re-ingests
 * the fixture feed so all 7 lines are unmatched again.
 *
 * Never touches non-fixture data: booking invoices, x402/manual payments and
 * their exceptions/approvals stay. Audit events are never deleted; a
 * `demo.reset` event is appended instead.
 */
export const resetFinanceDemo = internalMutation({
  args: {},
  returns: v.object({
    bankLinesRemoved: v.number(),
    applicationsRemoved: v.number(),
    exceptionsRemoved: v.number(),
    approvalsRemoved: v.number(),
    collectionTasksRemoved: v.number(),
    invoicesRestored: v.number(),
    nonFixtureInvoicesAdjusted: v.number(),
    bankLinesReingested: v.number(),
  }),
  handler: async (ctx) => {
    const fixtureLines = await ctx.db
      .query("bankTransactions")
      .withIndex("by_source_and_externalId", (q) => q.eq("source", "fixture"))
      .take(MAX_FIXTURE_BANK_LINES);

    const fixtureInvoices: Doc<"invoices">[] = [];
    for (const inv of FIXTURE_INVOICES) {
      const doc = await ctx.db
        .query("invoices")
        .withIndex("by_number", (q) => q.eq("number", inv.number))
        .first();
      if (doc && doc.source === "fixture") fixtureInvoices.push(doc);
    }
    const fixtureInvoiceIds = new Set<string>(fixtureInvoices.map((i) => i._id));

    let applicationsRemoved = 0;
    let exceptionsRemoved = 0;
    let approvalsRemoved = 0;
    let collectionTasksRemoved = 0;
    let nonFixtureInvoicesAdjusted = 0;
    const removedApprovals = new Set<string>();

    const removeApprovals = async (rows: Doc<"approvals">[]) => {
      for (const a of rows) {
        if (removedApprovals.has(a._id)) continue;
        removedApprovals.add(a._id);
        await ctx.db.delete(a._id);
        approvalsRemoved++;
      }
    };
    const removeException = async (ex: Doc<"financeExceptions">) => {
      await removeApprovals(
        await ctx.db
          .query("approvals")
          .withIndex("by_financeException", (q) => q.eq("financeExceptionId", ex._id))
          .take(50),
      );
      await ctx.db.delete(ex._id);
      exceptionsRemoved++;
    };

    for (const line of fixtureLines) {
      const apps = await ctx.db
        .query("paymentApplications")
        .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", line._id))
        .take(50);
      for (const app of apps) {
        // A manual match may have applied fixture cash to a real (booking) invoice: undo it there.
        if (!fixtureInvoiceIds.has(app.invoiceId)) {
          const inv = await ctx.db.get(app.invoiceId);
          if (inv) {
            await ctx.db.patch(inv._id, {
              paidMinor: Math.max(0, inv.paidMinor - app.amountMinor),
              status: inv.status === "paid" ? "partially_paid" : inv.status,
              paidAt: undefined,
            });
            await settleInvoice(ctx, inv._id, Date.now(), "system:demo-reset", "demo:reset");
            nonFixtureInvoicesAdjusted++;
          }
        }
        await ctx.db.delete(app._id);
        applicationsRemoved++;
      }
      const exceptions = await ctx.db
        .query("financeExceptions")
        .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", line._id))
        .take(50);
      for (const ex of exceptions) await removeException(ex);
      await removeApprovals(
        await ctx.db
          .query("approvals")
          .withIndex("by_subject", (q) => q.eq("subjectId", line._id))
          .take(50),
      );
    }

    for (const inv of fixtureInvoices) {
      await removeApprovals(
        await ctx.db
          .query("approvals")
          .withIndex("by_subject", (q) => q.eq("subjectId", inv._id))
          .take(50),
      );
      const tasks = await ctx.db
        .query("collectionTasks")
        .withIndex("by_invoice", (q) => q.eq("invoiceId", inv._id))
        .take(50);
      for (const task of tasks) {
        if (task.approvalId && !removedApprovals.has(task.approvalId)) {
          const a = await ctx.db.get(task.approvalId);
          if (a) await removeApprovals([a]);
        }
        await ctx.db.delete(task._id);
        collectionTasksRemoved++;
      }
    }

    // Approvals that targeted a fixture invoice via manual match from a non-fixture line
    // are already gone with their subject line; nothing else references fixture rows.
    for (const line of fixtureLines) await ctx.db.delete(line._id);

    const seeded = await seedFinanceFixture(ctx, true);

    const result = {
      bankLinesRemoved: fixtureLines.length,
      applicationsRemoved,
      exceptionsRemoved,
      approvalsRemoved,
      collectionTasksRemoved,
      invoicesRestored: seeded.invoicesRestored,
      nonFixtureInvoicesAdjusted,
      bankLinesReingested: seeded.bank.inserted.length,
    };
    await recordAudit(ctx, {
      traceId: "demo:reset",
      actor: "operator",
      type: "demo.reset",
      subjectId: "finance-fixture",
      reason: `Finance demo reset: removed ${result.bankLinesRemoved} fixture bank lines, ${applicationsRemoved} applications, ${exceptionsRemoved} exceptions, ${approvalsRemoved} approvals, ${collectionTasksRemoved} collection tasks; restored ${result.invoicesRestored} fixture invoices; re-ingested ${result.bankLinesReingested} lines. Non-fixture data untouched; audit history kept.`,
      data: result,
    });
    return result;
  },
});

/**
 * Release every active hold on the demo billboard (rehearsal helper).
 * Bookings and payments are NOT removed: they are financial records and the
 * audit trail is append-only. Rolling inventory (slots.ensureUpcoming) keeps
 * fresh slots available instead.
 */
export const resetBookingDemo = internalMutation({
  args: {},
  returns: v.object({ holdsReleased: v.number(), slotsCreated: v.number() }),
  handler: async (ctx) => {
    const billboard = await ctx.db
      .query("billboards")
      .withIndex("by_name", (q) => q.eq("name", BILLBOARD_NAME))
      .first();
    if (!billboard) return { holdsReleased: 0, slotsCreated: 0 };
    const holds = await ctx.db
      .query("holds")
      .withIndex("by_billboard_and_status", (q) =>
        q.eq("billboardId", billboard._id).eq("status", "active"),
      )
      .take(100);
    for (const hold of holds) {
      await endHold(ctx, hold, "released", "operator", "Demo reset: hold released");
    }
    const slotsCreated = await ensureUpcomingSlots(ctx, billboard._id, Date.now());
    await recordAudit(ctx, {
      traceId: "demo:reset",
      actor: "operator",
      type: "demo.reset",
      subjectId: billboard._id,
      reason: `Booking demo reset: released ${holds.length} active hold(s); bookings and payments kept (append-only).`,
      data: { holdsReleased: holds.length, slotsCreated },
    });
    return { holdsReleased: holds.length, slotsCreated };
  },
});

/**
 * Add one judge-supplied bank credit (source "fixture", so the UI shows it as
 * simulated and resetFinanceDemo removes it). Run reconciliation afterwards.
 */
export const addScenarioBankLine = internalMutation({
  args: { payerName: v.string(), amountMinor: v.number(), memo: v.string() },
  returns: v.object({ bankTransactionId: v.id("bankTransactions"), externalId: v.string() }),
  handler: async (ctx, args) => {
    const payerName = args.payerName.trim();
    const memo = args.memo.trim();
    if (payerName.length === 0 || payerName.length > 100) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "payerName must be 1..100 characters" });
    }
    if (memo.length > 200) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "memo must be at most 200 characters" });
    }
    if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0 || args.amountMinor > 10_000_000) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "amountMinor must be an integer in (0, 10000000] (US cents)",
      });
    }
    const externalId = `fx-scenario-${crypto.randomUUID().slice(0, 8)}`;
    const r = await ingestBankLines(
      ctx,
      [{ source: "fixture", externalId, amountMinor: args.amountMinor, postedAt: Date.now(), payerName, memo }],
      "operator:scenario",
    );
    return { bankTransactionId: r.inserted[0], externalId };
  },
});
