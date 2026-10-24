import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { audienceTags } from "./schema";
import { describeOverlap, matchScore, validateTags } from "./lib/match";
import { loadTrailingAudience } from "./lib/audienceWindow";
import { recordAudit } from "./lib/audit";
import { effectiveBaseline } from "./lib/pricing";
import { billboardDoc } from "./lib/validators";
import { requireOperator } from "./lib/operator";

/** All billboards (bounded; inventory is small). */
export const list = query({
  args: {},
  returns: v.array(billboardDoc),
  handler: async (ctx) => {
    return await ctx.db.query("billboards").take(100);
  },
});

const MAX_BASELINE = 100_000;

/**
 * Operator: set this screen's "normal traffic" (people per 15 min). Demand
 * pricing compares measured audience against it.
 * Operator only.
 */
export const setAudienceBaseline = mutation({
  args: { billboardId: v.id("billboards"), peoplePer15Min: v.number() },
  returns: v.object({
    billboardId: v.id("billboards"),
    previous: v.number(),
    audienceBaselinePerBucket: v.number(),
  }),
  handler: async (ctx, args) => {
    const operator = await requireOperator(ctx);
    if (
      !Number.isSafeInteger(args.peoplePer15Min) ||
      args.peoplePer15Min < 1 ||
      args.peoplePer15Min > MAX_BASELINE
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `peoplePer15Min must be an integer in [1, ${MAX_BASELINE}]`,
      });
    }
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    const previous = effectiveBaseline(billboard.audienceBaselinePerBucket);
    await ctx.db.patch(billboard._id, { audienceBaselinePerBucket: args.peoplePer15Min });
    await recordAudit(ctx, {
      traceId: `billboard:${billboard._id}`,
      actor: operator.actor,
      type: "billboard.baseline_changed",
      subjectId: billboard._id,
      reason: `Normal traffic for ${billboard.name} changed from ${previous} to ${args.peoplePer15Min} people per 15 min`,
      data: { previous, next: args.peoplePer15Min },
    });
    return {
      billboardId: billboard._id,
      previous,
      audienceBaselinePerBucket: args.peoplePer15Min,
    };
  },
});

/**
 * Screens ranked for a campaign (or an ad-hoc target audience): audience match
 * x expected audience = relevant viewers per 15 minutes. Public, so buyer
 * agents can use it to choose screens and value bids. Matching never changes
 * the posted screen price.
 */
export const recommend = query({
  args: {
    campaignId: v.optional(v.id("campaigns")),
    targetAudience: v.optional(audienceTags),
  },
  returns: v.array(
    v.object({
      billboardId: v.id("billboards"),
      name: v.string(),
      city: v.string(),
      locationLabel: v.string(),
      audienceTags: v.optional(audienceTags),
      /** 0..1, null if either side has no audience profile. */
      matchScore: v.union(v.number(), v.null()),
      expectedAudiencePer15Min: v.number(),
      audienceBasis: v.union(v.literal("measured"), v.literal("normal_traffic")),
      relevantViewersPer15Min: v.number(),
      explanation: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    let target = args.targetAudience;
    if (!target && args.campaignId) {
      const campaign = await ctx.db.get(args.campaignId);
      if (!campaign) throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found" });
      target = campaign.targetAudience;
    }
    if (target && validateTags(target)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: validateTags(target)! });
    }
    const now = Date.now();
    const billboards = await ctx.db.query("billboards").take(50);
    const rows = [];
    for (const b of billboards) {
      const { sample } = await loadTrailingAudience(ctx.db, b._id, now);
      const normal = effectiveBaseline(b.audienceBaselinePerBucket);
      const measured = sample !== null && (sample.window?.coverage ?? 0) >= 0.5;
      const expected = measured ? sample!.countEstimate : normal;
      const score = matchScore(b.audienceTags, target);
      // Unknown match counts as half relevant, and says so.
      const effectiveScore = score ?? 0.5;
      const relevant = Math.round(expected * effectiveScore * 10) / 10;
      const matchText =
        score === null
          ? "No audience profile to match against (assumed 50%)"
          : `Match ${Math.round(score * 100)}%. ${describeOverlap(b.audienceTags, target)}`;
      rows.push({
        billboardId: b._id,
        name: b.name,
        city: b.city,
        locationLabel: b.locationLabel,
        audienceTags: b.audienceTags,
        matchScore: score,
        expectedAudiencePer15Min: expected,
        audienceBasis: measured ? ("measured" as const) : ("normal_traffic" as const),
        relevantViewersPer15Min: relevant,
        explanation: `${matchText}. ${measured ? `${expected} people in the last 15 min (camera)` : `${expected} people per 15 min is normal here`}, so about ${relevant} relevant viewers per 15 min.`,
      });
    }
    rows.sort((a, b) => b.relevantViewersPer15Min - a.relevantViewersPer15Min || a.name.localeCompare(b.name));
    return rows;
  },
});

/** Operator: set who is likely in front of this screen (used for matching, not price). */
export const setAudienceTags = mutation({
  args: { billboardId: v.id("billboards"), audienceTags },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operator = await requireOperator(ctx);
    const problem = validateTags(args.audienceTags);
    if (problem) throw new ConvexError({ code: "INVALID_INPUT", message: problem });
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    await ctx.db.patch(billboard._id, { audienceTags: args.audienceTags });
    await recordAudit(ctx, {
      traceId: `billboard:${billboard._id}`,
      actor: operator.actor,
      type: "billboard.audience_tags_changed",
      subjectId: billboard._id,
      reason: `Audience profile for ${billboard.name} set to ${Object.entries(args.audienceTags).map(([k, w]) => `${k} ${w}`).join(", ")}`,
    });
    return null;
  },
});
