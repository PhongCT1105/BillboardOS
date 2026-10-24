import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { issueAgentKey } from "./agentKeys";
import { insertRule } from "./watchRules";
import type { Doc, Id } from "./_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { ensureUpcomingSlots } from "./lib/inventory";
import { ingestBankLines } from "./bank";
import { endHold } from "./holds";
import { settleInvoice } from "./lib/finance";
import { upsertEvent } from "./events";
import {
  FIXTURE_ADVERTISERS,
  FIXTURE_BANK_LINES,
  FIXTURE_INVOICES,
} from "./fixtures/financeFixture";

const BILLBOARD_NAME = "Moscone West Screen";
/** The demo host workspace that owns all seeded inventory and finance data (ADR 0004). */
export const DEMO_WORKSPACE_NAME = "Moscone Media";

/** Find or create the demo host workspace (no owner until someone is migrated/invited in). */
export async function ensureDemoWorkspace(ctx: MutationCtx): Promise<Id<"workspaces">> {
  const existing = await ctx.db
    .query("workspaces")
    .withIndex("by_name", (q) => q.eq("name", DEMO_WORKSPACE_NAME))
    .first();
  if (existing) return existing._id;
  return await ctx.db.insert("workspaces", { name: DEMO_WORKSPACE_NAME, city: "San Francisco" });
}
/** Moscone West: mostly software people, some startups, some tourists. */
const MOSCONE_AUDIENCE = { software: 0.6, startups: 0.2, tourists: 0.2 };

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
    const workspaceId = await ensureDemoWorkspace(ctx);

    let billboard = await ctx.db
      .query("billboards")
      .withIndex("by_name", (q) => q.eq("name", BILLBOARD_NAME))
      .first();
    let slotsCreated = 0;
    if (!billboard) {
      created = true;
      const billboardId = await ctx.db.insert("billboards", {
        workspaceId,
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
    if (!billboard.workspaceId) {
      await ctx.db.patch(billboard._id, { workspaceId });
      billboard = (await ctx.db.get(billboard._id))!;
    }
    // Who is likely in front of the screen (matching only; never changes price).
    if (!billboard.audienceTags) {
      await ctx.db.patch(billboard._id, { audienceTags: MOSCONE_AUDIENCE });
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
        workspaceId: await ensureDemoWorkspace(ctx),
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
  const workspaceId = await ensureDemoWorkspace(ctx);
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
      workspaceId,
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

  const bank = await ingestBankLines(ctx, workspaceId, FIXTURE_BANK_LINES, "system:fixture");
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
        workspaceId: await ensureDemoWorkspace(ctx),
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
    const demoWorkspaceId = await ensureDemoWorkspace(ctx);
    const fixtureLines = (
      await ctx.db
        .query("bankTransactions")
        .withIndex("by_source_and_externalId", (q) => q.eq("source", "fixture"))
        .take(MAX_FIXTURE_BANK_LINES)
    ).filter((l) => l.workspaceId === undefined || l.workspaceId === demoWorkspaceId);

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
      workspaceId: await ensureDemoWorkspace(ctx),
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
      workspaceId: await ensureDemoWorkspace(ctx),
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
      await ensureDemoWorkspace(ctx),
      [{ source: "fixture", externalId, amountMinor: args.amountMinor, postedAt: Date.now(), payerName, memo }],
      "operator:scenario",
    );
    return { bankTransactionId: r.inserted[0], externalId };
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Pricing world for ADR 0003 demos (`npx convex run seed:pricingDemo`),
 * idempotent. Run after seed:demo.
 *  - A conference at Moscone today 08:00-18:00 local (event uplift x1.3, SEEDED).
 *  - Target audiences for the demo campaigns (matching and agent bids).
 *  - "Nvidia" (big brand, prepay) with a "Nvidia GTC promo" campaign, for the
 *    two-agent auction demo against Golden Gate Coffee.
 */
export const pricingDemo = internalMutation({
  args: {},
  returns: v.object({
    eventId: v.id("events"),
    eventCreated: v.boolean(),
    nvidiaAdvertiserId: v.id("advertisers"),
    nvidiaCampaignId: v.id("campaigns"),
    goldenGateCampaignId: v.union(v.id("campaigns"), v.null()),
  }),
  handler: async (ctx) => {
    const billboard = await ctx.db
      .query("billboards")
      .withIndex("by_name", (q) => q.eq("name", BILLBOARD_NAME))
      .first();
    if (!billboard) {
      throw new ConvexError({ code: "NOT_SEEDED", message: "Run seed:demo first" });
    }
    if (!billboard.audienceTags) await ctx.db.patch(billboard._id, { audienceTags: MOSCONE_AUDIENCE });

    // Today's local midnight for the screen's fixed offset.
    const now = Date.now();
    const offsetMs = billboard.utcOffsetMinutes * 60_000;
    const localMidnight = Math.floor((now + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
    const event = await upsertEvent(
      ctx,
      {
        billboardId: billboard._id,
        name: "DevWorld Summit (Moscone West)",
        startsAt: localMidnight + 8 * HOUR_MS,
        endsAt: localMidnight + 18 * HOUR_MS,
        expectedAttendance: 25_000,
        audienceTags: { software: 0.7, startups: 0.2, press: 0.1 },
        upliftMultiplier: 1.3,
        confidence: 0.8,
        source: "seed",
        explanation: "SEEDED demo event: a large developer conference next door draws software and startup crowds.",
      },
      "system:seed",
    );

    let nvidia = await ctx.db
      .query("advertisers")
      .withIndex("by_displayName", (q) => q.eq("displayName", "Nvidia"))
      .first();
    const nvidiaAdvertiserId = nvidia?._id ?? (await ctx.db.insert("advertisers", { displayName: "Nvidia", paymentTerms: "prepay" }));
    nvidia = (await ctx.db.get(nvidiaAdvertiserId))!;
    let nvidiaCampaign = await ctx.db
      .query("campaigns")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", nvidiaAdvertiserId))
      .first();
    if (!nvidiaCampaign) {
      const id = await ctx.db.insert("campaigns", {
        advertiserId: nvidiaAdvertiserId,
        brief: "Nvidia GTC promo: reach developers and AI builders near Moscone during conference week.",
        targetCity: "San Francisco",
        budgetMinor: 500_000, // $5,000
        currency: "USD",
        status: "active",
        creativeStatus: "none",
        targetAudience: { software: 0.6, ai: 0.4 },
      });
      nvidiaCampaign = (await ctx.db.get(id))!;
    }

    const goldenGate = await ctx.db
      .query("advertisers")
      .withIndex("by_displayName", (q) => q.eq("displayName", "Golden Gate Coffee Co."))
      .first();
    let goldenGateCampaignId: Id<"campaigns"> | null = null;
    if (goldenGate) {
      const c = await ctx.db
        .query("campaigns")
        .withIndex("by_advertiser", (q) => q.eq("advertiserId", goldenGate._id))
        .first();
      if (c) {
        goldenGateCampaignId = c._id;
        if (!c.targetAudience) {
          await ctx.db.patch(c._id, { targetAudience: { tourists: 0.4, software: 0.3, startups: 0.3 } });
        }
      }
    }

    return {
      eventId: event.eventId,
      eventCreated: event.created,
      nvidiaAdvertiserId,
      nvidiaCampaignId: nvidiaCampaign._id,
      goldenGateCampaignId,
    };
  },
});

/** Demo buying agents (one per demo company); the scripts use these keys. */
export const DEMO_AGENTS = [
  { company: "Golden Gate Coffee Co.", budgetCapMinor: 30_000, envVar: "BUYER_AGENT_KEY / AUCTION_COFFEE_AGENT_KEY" },
  { company: "Nvidia", budgetCapMinor: 500_000, envVar: "AUCTION_NVIDIA_AGENT_KEY" },
] as const;
const DEMO_KEY_NAME = "demo-agent";

/**
 * Issue fresh agent keys for the two demo companies (run after seed:demo and
 * seed:pricingDemo) and print them ONCE:
 *   npx convex run seed:demoAgentKeys
 * Idempotent in effect: earlier "demo-agent" keys of those companies are
 * revoked first, so only the printed keys work.
 */
export const demoAgentKeys = internalMutation({
  args: {},
  returns: v.array(
    v.object({
      company: v.string(),
      envVar: v.string(),
      key: v.string(),
      prefix: v.string(),
      webhookSecret: v.string(),
      budgetCapMinor: v.number(),
      revokedPrevious: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const out = [];
    for (const spec of DEMO_AGENTS) {
      const advertiser = await ctx.db
        .query("advertisers")
        .withIndex("by_displayName", (q) => q.eq("displayName", spec.company))
        .first();
      if (!advertiser) {
        throw new ConvexError({ code: "NOT_SEEDED", message: `${spec.company} not found; run seed:demo and seed:pricingDemo first` });
      }
      let revokedPrevious = 0;
      for (const k of await ctx.db
        .query("agentKeys")
        .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiser._id))
        .take(100)) {
        if (k.name === DEMO_KEY_NAME && k.revokedAt === undefined) {
          await ctx.db.patch(k._id, { revokedAt: Date.now() });
          revokedPrevious++;
        }
      }
      const issued = await issueAgentKey(ctx, {
        advertiserId: advertiser._id,
        name: DEMO_KEY_NAME,
        scopes: ["quote", "hold", "bid", "pay"],
        budgetCapMinor: spec.budgetCapMinor,
        expiresInDays: 30,
        createdBy: "system:seed",
      });
      out.push({
        company: spec.company,
        envVar: spec.envVar,
        key: issued.key,
        prefix: issued.prefix,
        webhookSecret: issued.webhookSecret,
        budgetCapMinor: spec.budgetCapMinor,
        revokedPrevious,
      });
    }
    return out;
  },
});

/**
 * Make an existing account an owner of the demo "Moscone Media" workspace
 * (it has no owner after migration when nobody had signed up yet):
 *   npx convex run seed:addDemoOwner '{"email":"you@example.com"}'
 */
export const addDemoOwner = internalMutation({
  args: { email: v.string() },
  returns: v.object({ workspaceId: v.id("workspaces"), added: v.boolean() }),
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (!user) throw new ConvexError({ code: "USER_NOT_FOUND", message: "Sign up with this email first" });
    const workspaceId = await ensureDemoWorkspace(ctx);
    const existing = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", user._id))
      .unique();
    if (!existing) await ctx.db.insert("workspaceMembers", { workspaceId, userId: user._id, email, role: "owner" });
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (!profile) await ctx.db.insert("profiles", { userId: user._id, accountType: "host", activeWorkspaceId: workspaceId });
    else await ctx.db.patch(profile._id, { activeWorkspaceId: workspaceId });
    const workspace = (await ctx.db.get(workspaceId))!;
    if (!workspace.ownerUserId) await ctx.db.patch(workspaceId, { ownerUserId: user._id });
    await recordAudit(ctx, {
      workspaceId,
      traceId: `workspace:${workspaceId}`,
      actor: "system:cli",
      type: "workspace.member_added",
      subjectId: user._id,
      reason: `${email} added as owner of ${DEMO_WORKSPACE_NAME} (CLI)`,
    });
    return { workspaceId, added: !existing };
  },
});

/**
 * Let an existing (signed-up) account act for a demo company, e.g. to see its
 * alerts inbox in the customer dashboard:
 *   npx convex run seed:addDemoCustomer '{"email":"you@example.com","company":"Nvidia"}'
 * Host accounts can't also be customers.
 */
export const addDemoCustomer = internalMutation({
  args: { email: v.string(), company: v.string() },
  returns: v.object({ advertiserId: v.id("advertisers"), added: v.boolean() }),
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first();
    if (!user) throw new ConvexError({ code: "USER_NOT_FOUND", message: "Sign up with this email first" });
    const advertiser = await ctx.db
      .query("advertisers")
      .withIndex("by_displayName", (q) => q.eq("displayName", args.company))
      .first();
    if (!advertiser) throw new ConvexError({ code: "NOT_FOUND", message: `No company named ${args.company}` });
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (profile?.accountType === "host") {
      throw new ConvexError({ code: "HOST_ACCOUNT", message: "That account is a host; sign up a separate customer account" });
    }
    if (!profile) await ctx.db.insert("profiles", { userId: user._id, accountType: "customer" });
    const existing = await ctx.db
      .query("advertiserMembers")
      .withIndex("by_advertiser_and_user", (q) => q.eq("advertiserId", advertiser._id).eq("userId", user._id))
      .unique();
    if (!existing) {
      await ctx.db.insert("advertiserMembers", {
        advertiserId: advertiser._id,
        userId: user._id,
        email,
        role: advertiser.ownerUserId ? "member" : "owner",
      });
      if (!advertiser.ownerUserId) await ctx.db.patch(advertiser._id, { ownerUserId: user._id });
    }
    return { advertiserId: advertiser._id, added: !existing };
  },
});

const DEMO_WEBHOOK_KEY_NAME = "demo-webhook";
const DEMO_RULE_NAMES = ["Morning coffee crowd", "Developer screens for GTC"];

/**
 * One sensible watch rule per demo company (run after seed:demo,
 * seed:pricingDemo):
 *   npx convex run seed:demoWatchRules '{"webhookUrl":"https://<tunnel>/alerts"}'
 *  - Golden Gate Coffee: inbox alerts for SF morning slots under $60.
 *  - Nvidia: inbox + agent webhook for software-heavy screens under $150,
 *    including auctions. Issues a fresh "demo-webhook" agent key (earlier ones
 *    are revoked) and prints its webhook secret ONCE for `npm run webhook:listen`.
 * Idempotent: earlier demo rules with the same names are replaced (and their
 * alerts deleted). `clearAlerts: true` also empties both companies' inboxes.
 */
export const demoWatchRules = internalMutation({
  args: { webhookUrl: v.optional(v.string()), clearAlerts: v.optional(v.boolean()) },
  returns: v.object({
    rules: v.array(v.object({ company: v.string(), ruleId: v.id("watchRules"), summary: v.string() })),
    webhook: v.object({
      company: v.string(),
      url: v.string(),
      keyPrefix: v.string(),
      key: v.string(),
      webhookSecret: v.string(),
      envVar: v.string(),
    }),
    replacedRules: v.number(),
    deletedAlerts: v.number(),
  }),
  handler: async (ctx, args) => {
    const webhookUrl = args.webhookUrl?.trim() || "http://localhost:8787/alerts";
    const companyCampaign = async (displayName: string) => {
      const advertiser = await ctx.db
        .query("advertisers")
        .withIndex("by_displayName", (q) => q.eq("displayName", displayName))
        .first();
      const campaign = advertiser
        ? await ctx.db
            .query("campaigns")
            .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiser._id))
            .first()
        : null;
      if (!advertiser || !campaign) {
        throw new ConvexError({ code: "NOT_SEEDED", message: `${displayName} not found; run seed:demo and seed:pricingDemo first` });
      }
      return { advertiser, campaign };
    };
    const coffee = await companyCampaign("Golden Gate Coffee Co.");
    const nvidia = await companyCampaign("Nvidia");

    let replacedRules = 0;
    let deletedAlerts = 0;
    for (const advertiserId of [coffee.advertiser._id, nvidia.advertiser._id]) {
      if (args.clearAlerts) {
        for (const a of await ctx.db
          .query("alerts")
          .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
          .take(500)) {
          await ctx.db.delete(a._id);
          deletedAlerts++;
        }
      }
      for (const r of await ctx.db
        .query("watchRules")
        .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
        .take(100)) {
        if (DEMO_RULE_NAMES.includes(r.name)) {
          for (const a of await ctx.db
            .query("alerts")
            .withIndex("by_rule", (q) => q.eq("ruleId", r._id))
            .take(500)) {
            await ctx.db.delete(a._id);
            deletedAlerts++;
          }
          await ctx.db.delete(r._id);
          await ctx.scheduler.runAfter(0, internal.watchRules.cleanupMatches, { ruleId: r._id });
          replacedRules++;
        }
      }
    }
    for (const k of await ctx.db
      .query("agentKeys")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", nvidia.advertiser._id))
      .take(100)) {
      if (k.name === DEMO_WEBHOOK_KEY_NAME && k.revokedAt === undefined) await ctx.db.patch(k._id, { revokedAt: Date.now() });
    }
    const key = await issueAgentKey(ctx, {
      advertiserId: nvidia.advertiser._id,
      name: DEMO_WEBHOOK_KEY_NAME,
      scopes: ["quote", "hold", "bid"],
      campaignIds: [nvidia.campaign._id],
      budgetCapMinor: 200_000,
      expiresInDays: 30,
      webhookUrl,
      createdBy: "system:seed",
    });

    const coffeeRule = await insertRule(
      ctx,
      coffee.advertiser._id,
      {
        campaignId: coffee.campaign._id,
        name: DEMO_RULE_NAMES[0],
        cities: ["San Francisco"],
        maxPriceMinor: 6000,
        hourStart: 7,
        hourEnd: 11,
        triggers: ["available", "price_drop", "last_minute"],
        delivery: ["inbox"],
      },
      "system:seed",
    );
    const nvidiaRule = await insertRule(
      ctx,
      nvidia.advertiser._id,
      {
        campaignId: nvidia.campaign._id,
        name: DEMO_RULE_NAMES[1],
        cities: ["San Francisco"],
        minMatch: 0.5,
        maxPriceMinor: 15_000,
        triggers: ["available", "price_drop", "auction_open"],
        delivery: ["inbox", "agent"],
        agentKeyId: key.agentKeyId,
      },
      "system:seed",
    );
    return {
      rules: [
        { company: coffee.advertiser.displayName, ...coffeeRule },
        { company: nvidia.advertiser.displayName, ...nvidiaRule },
      ],
      webhook: {
        company: nvidia.advertiser.displayName,
        url: webhookUrl,
        keyPrefix: key.prefix,
        key: key.key,
        webhookSecret: key.webhookSecret,
        envVar: "WEBHOOK_SECRET",
      },
      replacedRules,
      deletedAlerts,
    };
  },
});
