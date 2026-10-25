import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { researchMethod } from "./schemaParts/sales";
import { cleanTags, clampFactor } from "./lib/research";

/**
 * The two research agents (Claude; the calls are in researchNode.ts):
 *   - company research: once per company (and when its ad changes), who it
 *     sells to (matching) and how much the right crowd is worth to it (its
 *     own price factor);
 *   - audience read: per screen, from where it is, the time and any event,
 *     who is likely in front of it. Refreshed every hour.
 * Both fall back to simple rules when Claude isn't configured or fails, and
 * say so (method "rules").
 */

const AUDIENCE_TTL_MS = 60 * 60_000;
const DEBOUNCE_MS = 30_000;
const MAX_CAMPAIGNS = 10;
const MAX_SCREENS = 200;

// ---------------------------------------------------------------- company research

export async function researchOf(ctx: QueryCtx, advertiserId: Id<"advertisers">): Promise<Doc<"companyResearch"> | null> {
  return await ctx.db
    .query("companyResearch")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .unique();
}

/** Research (or re-research) this company soon. Debounced. */
export async function requestResearch(ctx: MutationCtx, advertiserId: Id<"advertisers">, opts: { force?: boolean } = {}): Promise<void> {
  const row = await researchOf(ctx, advertiserId);
  if (row && !opts.force) return;
  if (row && Date.now() - row.researchedAt < DEBOUNCE_MS) return;
  await ctx.scheduler.runAfter(0, internal.researchNode.researchCompany, { advertiserId });
}

export const companyInputs = internalQuery({
  args: { advertiserId: v.id("advertisers") },
  returns: v.union(
    v.null(),
    v.object({
      name: v.string(),
      briefs: v.array(v.string()),
      videos: v.array(v.object({ title: v.union(v.string(), v.null()), author: v.union(v.string(), v.null()), description: v.union(v.string(), v.null()) })),
      targetAudience: v.union(v.record(v.string(), v.number()), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const advertiser = await ctx.db.get(args.advertiserId);
    if (!advertiser) return null;
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", args.advertiserId))
      .order("desc")
      .take(MAX_CAMPAIGNS);
    const videos = await ctx.db
      .query("youtubeCreatives")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", args.advertiserId))
      .take(MAX_CAMPAIGNS);
    return {
      name: advertiser.displayName,
      briefs: campaigns.map((c) => c.brief).filter((b) => b.length > 0),
      videos: videos.map((y) => ({ title: y.title ?? null, author: y.author ?? null, description: y.description?.slice(0, 500) ?? null })),
      targetAudience: campaigns.find((c) => c.targetAudience)?.targetAudience ?? null,
    };
  },
});

export const saveResearch = internalMutation({
  args: {
    advertiserId: v.id("advertisers"),
    summary: v.string(),
    category: v.string(),
    audienceTags: v.record(v.string(), v.number()),
    priceFactor: v.number(),
    reasoning: v.string(),
    sources: v.array(v.string()),
    method: researchMethod,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const fields = {
      ...args,
      summary: args.summary.slice(0, 600),
      category: args.category.slice(0, 40),
      audienceTags: cleanTags(args.audienceTags) ?? { software: 0.5, startups: 0.5 },
      priceFactor: clampFactor(args.priceFactor),
      reasoning: args.reasoning.slice(0, 400),
      sources: args.sources.slice(0, 5).map((s) => s.slice(0, 300)),
      researchedAt: Date.now(),
    };
    const row = await researchOf(ctx, args.advertiserId);
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("companyResearch", fields);
    return null;
  },
});

// ---------------------------------------------------------------- audience read

/** Read who is in front of this screen soon (new screen, moved, or an event changed). */
export async function requestAudienceRead(ctx: MutationCtx, billboardId: Id<"billboards">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.researchNode.readAudience, { billboardId });
}

export const audienceInputs = internalQuery({
  args: { billboardId: v.id("billboards"), now: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      name: v.string(),
      city: v.string(),
      locationLabel: v.string(),
      latitude: v.union(v.number(), v.null()),
      longitude: v.union(v.number(), v.null()),
      localTime: v.string(),
      events: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const b = await ctx.db.get(args.billboardId);
    if (!b || b.retiredAt !== undefined) return null;
    const local = new Date(args.now + b.utcOffsetMinutes * 60_000);
    const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][local.getUTCDay()];
    const events = await ctx.db
      .query("events")
      .withIndex("by_billboard_and_startsAt", (q) => q.eq("billboardId", b._id).gte("startsAt", args.now - 24 * 60 * 60_000).lte("startsAt", args.now + 2 * 60 * 60_000))
      .take(10);
    return {
      name: b.name,
      city: b.city,
      locationLabel: b.locationLabel,
      latitude: b.latitude ?? null,
      longitude: b.longitude ?? null,
      localTime: `${day} ${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`,
      events: events.filter((e) => e.endsAt > args.now).map((e) => e.name),
    };
  },
});

export const saveAudience = internalMutation({
  args: { billboardId: v.id("billboards"), audienceTags: v.record(v.string(), v.number()), summary: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const tags = cleanTags(args.audienceTags);
    if (!tags) return null;
    await ctx.db.patch(args.billboardId, { audienceTags: tags, audienceSummary: args.summary.slice(0, 300), audienceReadAt: Date.now() });
    return null;
  },
});

/** Every hour: re-read the audience of each paired, online screen whose read is older than an hour. */
export const audienceSweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const screens = await ctx.db.query("billboards").take(MAX_SCREENS);
    for (const b of screens) {
      if (b.retiredAt !== undefined || !b.deviceId || b.deviceStatus !== "online") continue;
      if (b.audienceReadAt !== undefined && now - b.audienceReadAt < AUDIENCE_TTL_MS) continue;
      await requestAudienceRead(ctx, b._id);
    }
    return null;
  },
});

/**
 * Run both agents again everywhere: research every company with a campaign
 * and re-read every paired screen's audience (e.g. after setting or fixing
 * ANTHROPIC_API_KEY). npx convex run research:rerunAll
 */
export const rerunAll = internalMutation({
  args: {},
  returns: v.object({ companies: v.number(), screens: v.number() }),
  handler: async (ctx) => {
    const companies = new Set<Id<"advertisers">>();
    for (const c of await ctx.db.query("campaigns").take(500)) if (c.status === "active") companies.add(c.advertiserId);
    for (const advertiserId of companies) await ctx.scheduler.runAfter(0, internal.researchNode.researchCompany, { advertiserId });
    let screens = 0;
    for (const b of await ctx.db.query("billboards").take(MAX_SCREENS)) {
      if (b.retiredAt !== undefined || !b.deviceId) continue;
      await requestAudienceRead(ctx, b._id);
      screens++;
    }
    return { companies: companies.size, screens };
  },
});
