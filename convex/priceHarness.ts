/**
 * Price CREAO harness (background only): refine company priceFactor via the
 * BillboardOS Price Refine CREAO agent when configured. Never invites or bids.
 * Missing research still bootstraps through company research.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { creaoPool, creaoRateLimiter, creaoRetryAfterMs } from "./creaoLimits";
import { recordAudit } from "./lib/audit";
import { PRICE_FACTOR_MAX, PRICE_FACTOR_MIN } from "./lib/research";

const STALE_MS = 6 * 60 * 60_000;
/** Recently invited companies get a fresher priceFactor than idle ones. */
const ACTIVE_REFRESH_MS = 2 * 60 * 60_000;
const MAX_REFRESH_PER_TICK = 4;
/** Busy CREAO: try again later this many times, then keep the current research. */
const MAX_BUSY_RETRIES = 2;
const MAX_SCAN = 80;
const MAX_RECENT_BIDS = 40;
const MAX_OUTCOME_SCAN = 60;

async function advertisersNeedingPriceRefresh(ctx: QueryCtx, now: number): Promise<Id<"advertisers">[]> {
  const recentBids = await ctx.db.query("roundBids").order("desc").take(MAX_RECENT_BIDS);
  const recentlyInvited = new Set(recentBids.filter((b) => now - b._creationTime < ACTIVE_REFRESH_MS).map((b) => b.advertiserId));

  const agents = await ctx.db.query("companyAgents").take(MAX_SCAN);
  const out: Id<"advertisers">[] = [];
  const seen = new Set<string>();
  for (const a of agents) {
    if (!a.enabled || seen.has(a.advertiserId)) continue;
    const research = await ctx.db
      .query("companyResearch")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", a.advertiserId))
      .unique();
    const age = research ? now - research.researchedAt : Number.POSITIVE_INFINITY;
    const needsRefresh =
      !research || age >= STALE_MS || (recentlyInvited.has(a.advertiserId) && age >= ACTIVE_REFRESH_MS);
    if (!needsRefresh) continue;
    seen.add(a.advertiserId);
    out.push(a.advertiserId);
    if (out.length >= MAX_REFRESH_PER_TICK) break;
  }
  return out;
}

/** Advertisers whose research is missing, stale, or recently invited with aging factors. */
export const staleCompanies = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("advertisers")),
  handler: async (ctx, { now }) => advertisersNeedingPriceRefresh(ctx, now),
});

export const refineInputs = internalQuery({
  args: { advertiserId: v.id("advertisers") },
  returns: v.union(
    v.null(),
    v.object({
      companyName: v.string(),
      hasResearch: v.boolean(),
      current: v.union(
        v.null(),
        v.object({
          summary: v.string(),
          category: v.string(),
          audienceTags: v.record(v.string(), v.number()),
          priceFactor: v.number(),
          reasoning: v.string(),
        }),
      ),
      recentOutcomes: v.object({
        agreed: v.number(),
        rejectedPrice: v.number(),
        lostAfterAgree: v.number(),
      }),
    }),
  ),
  handler: async (ctx, { advertiserId }) => {
    const advertiser = await ctx.db.get(advertiserId);
    if (!advertiser) return null;
    const research = await ctx.db
      .query("companyResearch")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
      .unique();
    const bids = await ctx.db
      .query("roundBids")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
      .order("desc")
      .take(MAX_OUTCOME_SCAN);
    let agreed = 0;
    let rejectedPrice = 0;
    let lostAfterAgree = 0;
    for (const b of bids) {
      if (b.agreedAt !== undefined) {
        agreed += 1;
        if (b.status === "lost" || b.status === "defaulted") lostAfterAgree += 1;
      } else if (b.status === "passed" || b.status === "lost" || b.status === "invited") {
        rejectedPrice += 1;
      }
    }
    return {
      companyName: advertiser.displayName,
      hasResearch: Boolean(research) && research?.method !== "rules",
      current: research
        ? {
            summary: research.summary,
            category: research.category,
            audienceTags: research.audienceTags,
            priceFactor: research.priceFactor,
            reasoning: research.reasoning,
          }
        : null,
      recentOutcomes: { agreed, rejectedPrice, lostAfterAgree },
    };
  },
});

/**
 * One company: call Price Refine CREAO when configured and research exists;
 * otherwise bootstrap / refresh via company research.
 */
export const refineOne = internalAction({
  args: { advertiserId: v.id("advertisers"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const input = await ctx.runQuery(internal.priceHarness.refineInputs, args);
    if (!input) return null;

    if (!input.hasResearch || !input.current) {
      await ctx.runAction(internal.researchNode.researchCompany, { advertiserId: args.advertiserId });
      return null;
    }

    const traceId = `price:${args.advertiserId}:${Date.now()}`;
    const startedAt = Date.now();
    try {
      const result = await ctx.runAction(internal.creaoLive.run, {
        role: "price_refine",
        requestJson: JSON.stringify({
          schemaVersion: 1,
          role: "price_refine",
          traceId,
          advertiserId: args.advertiserId,
          companyName: input.companyName,
          current: input.current,
          recentOutcomes: input.recentOutcomes,
        }),
      });
      if (result === null) {
        // CREAO Price Refine not configured — full research refresh instead.
        await ctx.runAction(internal.researchNode.researchCompany, { advertiserId: args.advertiserId });
        return null;
      }
      if (
        result.advertiserId !== args.advertiserId ||
        result.status !== "refined" ||
        typeof result.priceFactor !== "number" ||
        !Number.isFinite(result.priceFactor) ||
        result.priceFactor < PRICE_FACTOR_MIN ||
        result.priceFactor > PRICE_FACTOR_MAX ||
        typeof result.reasoning !== "string"
      ) {
        throw new Error("CREAO price_refine result failed validation");
      }
      await ctx.runMutation(internal.research.saveResearch, {
        advertiserId: args.advertiserId,
        summary: input.current.summary,
        category: input.current.category,
        audienceTags: input.current.audienceTags,
        priceFactor: result.priceFactor,
        reasoning: result.reasoning,
        sources: Array.isArray(result.sources)
          ? result.sources.filter((s: unknown): s is string => typeof s === "string" && /^https:\/\//.test(s)).slice(0, 5)
          : [],
        method: "creao",
        startedAt,
      });
    } catch (error) {
      console.warn(`Price refine via CREAO failed for ${args.advertiserId}:`, error instanceof Error ? error.message : error);
      // Busy: wait our turn. Anything else: keep the current research; the next tick tries again.
      const retryAfter = creaoRetryAfterMs(error);
      const attempt = args.attempt ?? 0;
      if (retryAfter !== null && attempt < MAX_BUSY_RETRIES) {
        await creaoPool.enqueueAction(
          ctx,
          internal.priceHarness.refineOne,
          { advertiserId: args.advertiserId, attempt: attempt + 1 },
          { runAfter: retryAfter * (attempt + 1) },
        );
      }
    }
    return null;
  },
});

/** Cron: enqueue Price Refine (or research bootstrap) for stale / recently invited brands. */
export const tick = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const now = Date.now();
    const limit = await creaoRateLimiter.limit(ctx, "researchRefresh", { throws: false });
    if (!limit.ok) {
      await ctx.db.insert("harnessRuns", {
        kind: "price",
        status: "skipped",
        summary: `Price refine rate-limited for ${limit.retryAfter}ms`,
        at: now,
      });
      return { scheduled: 0 };
    }
    const ids = await advertisersNeedingPriceRefresh(ctx, now);
    for (const advertiserId of ids) {
      await creaoPool.enqueueAction(ctx, internal.priceHarness.refineOne, { advertiserId });
    }
    await ctx.db.insert("harnessRuns", {
      kind: "price",
      status: ids.length > 0 ? "ok" : "skipped",
      summary:
        ids.length > 0
          ? `Enqueued Price Refine CREAO for ${ids.length} compan${ids.length === 1 ? "y" : "ies"} (stale or recently invited)`
          : "No stale or recently invited company research",
      at: now,
    });
    if (ids.length > 0) {
      await recordAudit(ctx, {
        traceId: `harness:price:${now}`,
        actor: "price-harness",
        type: "harness.price_ran",
        subjectId: ids[0]!,
        reason: `Price harness enqueued ${ids.length} Price Refine run(s)`,
      });
    }
    return { scheduled: ids.length };
  },
});
