import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { audienceTags } from "./schema";
import { describeOverlap, matchScore, validateTags } from "./lib/match";
import { loadTrailingAudience } from "./lib/audienceWindow";
import { recordAudit } from "./lib/audit";
import { effectiveBaseline } from "./lib/pricing";
import { billboardDoc } from "./lib/validators";
import { requireWorkspaceMember, resolveWorkspace, workspaceOfBillboard } from "./lib/tenancy";
import { ensureUpcomingSlots } from "./lib/inventory";

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
    const operator = await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
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
      workspaceId: billboard.workspaceId,
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
    const operator = await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
    const problem = validateTags(args.audienceTags);
    if (problem) throw new ConvexError({ code: "INVALID_INPUT", message: problem });
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    await ctx.db.patch(billboard._id, { audienceTags: args.audienceTags });
    await recordAudit(ctx, {
      workspaceId: billboard.workspaceId,
      traceId: `billboard:${billboard._id}`,
      actor: operator.actor,
      type: "billboard.audience_tags_changed",
      subjectId: billboard._id,
      reason: `Audience profile for ${billboard.name} set to ${Object.entries(args.audienceTags).map(([k, w]) => `${k} ${w}`).join(", ")}`,
    });
    return null;
  },
});

/** Screens of the caller's (active) workspace. */
export const mine = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(billboardDoc),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    return await ctx.db
      .query("billboards")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .take(100);
  },
});

/** Host adds a screen to their workspace; 12 hours of 15-minute slots go on sale right away. */
export const create = mutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    name: v.string(),
    city: v.string(),
    locationLabel: v.string(),
    utcOffsetMinutes: v.number(),
    baseRateMinor: v.number(),
    reserveFloorMinor: v.number(),
  },
  returns: v.id("billboards"),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const name = args.name.trim();
    const city = args.city.trim();
    const locationLabel = args.locationLabel.trim();
    if ([name, city, locationLabel].some((x) => x.length === 0 || x.length > 120)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Name, city and location must be 1..120 characters" });
    }
    if (!Number.isInteger(args.utcOffsetMinutes) || Math.abs(args.utcOffsetMinutes) > 14 * 60) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "utcOffsetMinutes must be an integer within +-840" });
    }
    for (const [label, value] of [["baseRateMinor", args.baseRateMinor], ["reserveFloorMinor", args.reserveFloorMinor]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) {
        throw new ConvexError({ code: "INVALID_INPUT", message: `${label} must be an integer in (0, 1000000] (US cents)` });
      }
    }
    if (args.reserveFloorMinor > args.baseRateMinor) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Reserve floor can't exceed the base rate" });
    }
    const existing = await ctx.db
      .query("billboards")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (existing) throw new ConvexError({ code: "NAME_TAKEN", message: "A screen with this name already exists" });
    const billboardId = await ctx.db.insert("billboards", {
      workspaceId: me.workspaceId,
      name,
      city,
      locationLabel,
      utcOffsetMinutes: args.utcOffsetMinutes,
      baseRateMinor: args.baseRateMinor,
      reserveFloorMinor: args.reserveFloorMinor,
      deviceStatus: "online",
    });
    const slots = await ensureUpcomingSlots(ctx, billboardId, Date.now());
    await recordAudit(ctx, {
      workspaceId: me.workspaceId,
      traceId: `billboard:${billboardId}`,
      actor: me.actor,
      type: "inventory.generated",
      subjectId: billboardId,
      reason: `${me.email} added screen ${name} (${city}) with ${slots} upcoming slot(s)`,
    });
    return billboardId;
  },
});
