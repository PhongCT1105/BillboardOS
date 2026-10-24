import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { audienceTags, brandTier, companyAssessmentFields } from "./schema";
import { recordAudit } from "./lib/audit";
import { requireOperator } from "./lib/operator";
import {
  OVERRIDE_TTL_MS,
  REQUEST_DEBOUNCE_MS,
  VALUATION_MAX,
  VALUATION_MIN,
  VALUATION_TTL_MS,
  clampMultiplier,
  summarizeInputs,
  type CompanyInputs,
} from "./lib/valuation";

const MAX_CAMPAIGNS = 20;
const MAX_PER_CAMPAIGN = 50;
const MAX_INVOICES = 50;
const MAX_MARKET_SALES = 50;
const LATE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Company-level inputs for the analyst: profile, campaign submissions,
 * interaction and payment history with us, and market prices. Bounded reads;
 * no individual people, nothing from the camera.
 */
export async function gatherCompanyInputs(
  db: QueryCtx["db"],
  advertiserId: Id<"advertisers">,
): Promise<CompanyInputs> {
  const advertiser = await db.get(advertiserId);
  if (!advertiser) throw new ConvexError({ code: "NOT_FOUND", message: "Advertiser not found" });
  const campaigns = await db
    .query("campaigns")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .take(MAX_CAMPAIGNS);

  let quotes = 0;
  let bookings = 0;
  let spendMinor = 0;
  for (const c of campaigns) {
    quotes += (
      await db
        .query("quotes")
        .withIndex("by_campaign", (q) => q.eq("campaignId", c._id))
        .take(MAX_PER_CAMPAIGN)
    ).length;
    const bs = await db
      .query("bookings")
      .withIndex("by_campaign_and_status", (q) => q.eq("campaignId", c._id))
      .take(MAX_PER_CAMPAIGN);
    const kept = bs.filter((b) => b.status !== "failed");
    bookings += kept.length;
    spendMinor += kept.reduce((s, b) => s + b.amountMinor, 0);
  }

  const invoices = await db
    .query("invoices")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .take(MAX_INVOICES);
  const paid = invoices.filter((i) => i.paidAt !== undefined);
  const paidLate = paid.filter((i) => i.paidAt! - i.dueAt > LATE_GRACE_MS).length;

  const sales = await db.query("priceHistory").withIndex("by_recordedAt").order("desc").take(MAX_MARKET_SALES);
  const averageSaleRatio =
    sales.length > 0 ? Math.round((sales.reduce((s, r) => s + r.normalizedRatio, 0) / sales.length) * 100) / 100 : null;

  return {
    displayName: advertiser.displayName,
    paymentTerms: advertiser.paymentTerms,
    campaigns: campaigns.map((c) => ({
      brief: c.brief.slice(0, 500),
      budgetUsd: Math.round(c.budgetMinor / 100),
      targetCity: c.targetCity ?? null,
      targetAudience: c.targetAudience ?? null,
      status: c.status,
    })),
    history: { quotes, bookings, spendUsd: Math.round(spendMinor / 100) },
    payments: {
      invoices: invoices.length,
      paidLate,
      writtenOffOrDisputed: invoices.filter((i) => i.status === "written_off" || i.status === "disputed").length,
      paidOnTime: paid.length - paidLate,
    },
    market: { averageSaleRatio, sales: sales.length },
  };
}

/** Latest assessment for a company and whether it is still fresh. */
export async function currentAssessment(
  db: QueryCtx["db"],
  advertiserId: Id<"advertisers">,
  now: number,
): Promise<{ assessment: Doc<"companyAssessments"> | null; fresh: boolean }> {
  const latest = await db
    .query("companyAssessments")
    .withIndex("by_advertiser_and_assessedAt", (q) => q.eq("advertiserId", advertiserId))
    .order("desc")
    .first();
  return { assessment: latest, fresh: latest !== null && latest.expiresAt > now };
}

/**
 * Schedule a (re)assessment unless one was requested in the last 5 minutes.
 * Never blocks the caller; the action runs right after this transaction.
 */
export async function requestAssessment(
  ctx: MutationCtx,
  advertiserId: Id<"advertisers">,
  reason: string,
  force = false,
): Promise<boolean> {
  const advertiser = await ctx.db.get(advertiserId);
  if (!advertiser) return false;
  const now = Date.now();
  if (!force && advertiser.valuationRequestedAt !== undefined && now - advertiser.valuationRequestedAt < REQUEST_DEBOUNCE_MS) {
    return false;
  }
  await ctx.db.patch(advertiserId, { valuationRequestedAt: now });
  await ctx.scheduler.runAfter(0, internal.valuationAgent.assessCompany, { advertiserId, reason, force });
  return true;
}

export const companyInputs = v.object({
  displayName: v.string(),
  paymentTerms: v.string(),
  campaigns: v.array(
    v.object({
      brief: v.string(),
      budgetUsd: v.number(),
      targetCity: v.union(v.string(), v.null()),
      targetAudience: v.union(audienceTags, v.null()),
      status: v.string(),
    }),
  ),
  history: v.object({ quotes: v.number(), bookings: v.number(), spendUsd: v.number() }),
  payments: v.object({
    invoices: v.number(),
    paidLate: v.number(),
    writtenOffOrDisputed: v.number(),
    paidOnTime: v.number(),
  }),
  market: v.object({ averageSaleRatio: v.union(v.number(), v.null()), sales: v.number() }),
});

/** Inputs for the analyst action. */
export const gatherInputs = internalQuery({
  args: { advertiserId: v.id("advertisers") },
  returns: v.object({
    inputs: companyInputs,
    inputsSummary: v.string(),
    hasActiveOverride: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const inputs = await gatherCompanyInputs(ctx.db, args.advertiserId);
    const { assessment } = await currentAssessment(ctx.db, args.advertiserId, Date.now());
    return {
      inputs,
      inputsSummary: summarizeInputs(inputs),
      hasActiveOverride: assessment?.method === "override" && assessment.expiresAt > Date.now(),
    };
  },
});

/** Store an analyst result (clamped again here). An active operator override wins unless forced. */
export const saveAssessment = internalMutation({
  args: {
    advertiserId: v.id("advertisers"),
    multiplier: v.number(),
    brandTier,
    reasoning: v.string(),
    sources: v.array(v.string()),
    confidence: v.number(),
    method: v.union(v.literal("claude"), v.literal("heuristic")),
    model: v.optional(v.string()),
    inputsSummary: v.string(),
    force: v.optional(v.boolean()),
  },
  returns: v.union(v.id("companyAssessments"), v.null()),
  handler: async (ctx, args) => {
    const now = Date.now();
    const { assessment } = await currentAssessment(ctx.db, args.advertiserId, now);
    if (!args.force && assessment?.method === "override" && assessment.expiresAt > now) return null;
    const multiplier = clampMultiplier(args.multiplier);
    const id = await ctx.db.insert("companyAssessments", {
      advertiserId: args.advertiserId,
      multiplier,
      brandTier: args.brandTier,
      reasoning: args.reasoning.slice(0, 2000),
      sources: args.sources.slice(0, 10),
      confidence: Math.min(1, Math.max(0, args.confidence)),
      method: args.method,
      model: args.model,
      inputsSummary: args.inputsSummary.slice(0, 1000),
      assessedAt: now,
      expiresAt: now + VALUATION_TTL_MS,
    });
    await recordAudit(ctx, {
      traceId: `valuation:${args.advertiserId}`,
      actor: args.method === "claude" ? "agent:company-analyst" : "system:valuation-heuristic",
      type: "valuation.assessed",
      subjectId: args.advertiserId,
      reason: `x${multiplier.toFixed(2)} (${args.brandTier}, ${args.method}${args.model ? ` ${args.model}` : ""}): ${args.reasoning}`.slice(0, 1000),
      data: {
        multiplier,
        method: args.method,
        brandTier: args.brandTier,
        confidence: args.confidence,
        sources: args.sources.slice(0, 10),
      },
    });
    return id;
  },
});

/** Record that a model assessment failed and the heuristic was used instead. */
export const recordFailure = internalMutation({
  args: { advertiserId: v.id("advertisers"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordAudit(ctx, {
      traceId: `valuation:${args.advertiserId}`,
      actor: "agent:company-analyst",
      type: "valuation.failed",
      subjectId: args.advertiserId,
      reason: args.reason.slice(0, 1000),
    });
    return null;
  },
});

/** Operator pins a company's multiplier (clamped, audited, 30 days or until reassessed). */
export const override = mutation({
  args: { advertiserId: v.id("advertisers"), multiplier: v.number(), reason: v.string() },
  returns: v.object({ assessmentId: v.id("companyAssessments"), multiplier: v.number() }),
  handler: async (ctx, args) => {
    const operator = await requireOperator(ctx);
    if (!Number.isFinite(args.multiplier) || args.multiplier < VALUATION_MIN || args.multiplier > VALUATION_MAX) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `multiplier must be between ${VALUATION_MIN} and ${VALUATION_MAX}`,
      });
    }
    const reason = args.reason.trim().slice(0, 1000);
    if (reason.length === 0) throw new ConvexError({ code: "INVALID_INPUT", message: "A reason is required" });
    const advertiser = await ctx.db.get(args.advertiserId);
    if (!advertiser) throw new ConvexError({ code: "NOT_FOUND", message: "Advertiser not found" });
    const now = Date.now();
    const previous = await currentAssessment(ctx.db, args.advertiserId, now);
    const multiplier = clampMultiplier(args.multiplier);
    const assessmentId = await ctx.db.insert("companyAssessments", {
      advertiserId: args.advertiserId,
      multiplier,
      brandTier: previous.assessment?.brandTier ?? "unknown",
      reasoning: `Operator override: ${reason}`,
      sources: [],
      confidence: 1,
      method: "override",
      inputsSummary: previous.assessment
        ? `Replaces x${previous.assessment.multiplier.toFixed(2)} (${previous.assessment.method})`
        : "No previous assessment",
      assessedAt: now,
      expiresAt: now + OVERRIDE_TTL_MS,
      overriddenBy: operator.actor,
    });
    await recordAudit(ctx, {
      traceId: `valuation:${args.advertiserId}`,
      actor: operator.actor,
      type: "valuation.overridden",
      subjectId: args.advertiserId,
      reason: `${advertiser.displayName} pinned at x${multiplier.toFixed(2)}: ${reason}`,
      data: { multiplier, previous: previous.assessment?.multiplier ?? null },
    });
    return { assessmentId, multiplier };
  },
});

/** Operator re-runs the analyst now (clears an override once the new result lands). */
export const reassess = mutation({
  args: { advertiserId: v.id("advertisers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOperator(ctx);
    await requestAssessment(ctx, args.advertiserId, "operator re-assessment", true);
    return null;
  },
});

const assessmentView = v.object({
  _id: v.id("companyAssessments"),
  _creationTime: v.number(),
  ...companyAssessmentFields,
  fresh: v.boolean(),
});

/** Operator view: every advertiser with its current assessment (max 50). */
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      advertiserId: v.id("advertisers"),
      displayName: v.string(),
      paymentTerms: v.string(),
      assessment: v.union(assessmentView, v.null()),
    }),
  ),
  handler: async (ctx) => {
    await requireOperator(ctx);
    const now = Date.now();
    const advertisers = await ctx.db.query("advertisers").take(50);
    const rows = [];
    for (const a of advertisers) {
      const { assessment, fresh } = await currentAssessment(ctx.db, a._id, now);
      rows.push({
        advertiserId: a._id,
        displayName: a.displayName,
        paymentTerms: a.paymentTerms,
        assessment: assessment ? { ...assessment, fresh } : null,
      });
    }
    return rows;
  },
});

/** Operator view: the last 10 assessments for one company, newest first. */
export const history = query({
  args: { advertiserId: v.id("advertisers") },
  returns: v.array(assessmentView),
  handler: async (ctx, args) => {
    await requireOperator(ctx);
    const now = Date.now();
    const rows = await ctx.db
      .query("companyAssessments")
      .withIndex("by_advertiser_and_assessedAt", (q) => q.eq("advertiserId", args.advertiserId))
      .order("desc")
      .take(10);
    return rows.map((r) => ({ ...r, fresh: r.expiresAt > now }));
  },
});

