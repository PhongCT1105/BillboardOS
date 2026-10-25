import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { SPONSORS, isPosterSponsor, sponsorCreativeAuthor, sponsorCreativeTitle } from "./fixtures/sponsors";
import { configureAgent } from "./companyAgents";
import { budgetProblem, limitsFromBudget } from "./lib/companyAgent";
import { YOUTUBE_CONTENT_TYPE, defaultThumbnailUrl, parseYouTubeUrl } from "./lib/youtube";
import { recordAudit } from "./lib/audit";
import { requestResearch } from "./research";

/**
 * Seed the Cal Hacks company-sponsor **network** (fixtures/sponsors.ts): each
 * gets a campaign with its official YouTube ad or brand poster (approved for
 * every host), a built-in agent that is always on (its own key, limits from its
 * daily budget, a Base Sepolia wallet with a faucet claim), and a research run.
 * Idempotent: an existing sponsor is left as it is. Rounds invite only the top
 * 10 vibe matches per billboard from this pool.
 *   npx convex run sponsors:seed
 */
export const seed = internalMutation({
  args: {},
  returns: v.object({ created: v.array(v.string()), existing: v.array(v.string()) }),
  handler: async (ctx) => {
    const created: string[] = [];
    const existing: string[] = [];
    for (const s of SPONSORS) {
      const found = await ctx.db
        .query("advertisers")
        .withIndex("by_displayName", (q) => q.eq("displayName", s.name))
        .first();
      if (found) {
        existing.push(s.name);
        continue;
      }
      const budget = budgetProblem(s.dailyBudgetMinor);
      if (budget) throw new ConvexError({ code: "INVALID_INPUT", message: `${s.name}: ${budget}` });

      const now = Date.now();
      const title = sponsorCreativeTitle(s);
      const author = sponsorCreativeAuthor(s);
      const advertiserId = await ctx.db.insert("advertisers", { displayName: s.name, paymentTerms: "prepay" });

      if (isPosterSponsor(s)) {
        if (!s.posterSvg) throw new ConvexError({ code: "INVALID_INPUT", message: `${s.name}: missing posterSvg` });
        // Data URL so seed works without storage.store (convex-test) and without hotlinking.
        const posterUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.posterSvg)}`;
        const campaignId = await ctx.db.insert("campaigns", {
          advertiserId,
          brief: `Brand poster "${title}" by ${author}. ${s.summary}`.slice(0, 500),
          budgetMinor: s.dailyBudgetMinor * 30,
          currency: "USD",
          status: "active",
          creativeStatus: "approved",
          creativeExternalUrl: posterUrl,
          creativeContentType: "image/svg+xml",
          creativeSubmittedAt: now,
          creativeReviewReason: "Simulated sponsor: brand poster from public site identity (no verified YouTube ad)",
          targetAudience: s.targetAudience,
          audienceSource: "video",
        });
        const { maxPerSpotMinor, minRelevantViewers } = limitsFromBudget(s.dailyBudgetMinor);
        const { agentId } = await configureAgent(ctx, {
          campaign: (await ctx.db.get(campaignId))!,
          actor: "seed:sponsors",
          targetAudience: s.targetAudience,
          standing: { maxPricePerSpotMinor: maxPerSpotMinor, minRelevantViewers, dailyBudgetMinor: s.dailyBudgetMinor },
        });
        await ctx.db.patch(agentId, { autoTopUp: true });
        await requestResearch(ctx, advertiserId);
        await recordAudit(ctx, {
          traceId: `company:${advertiserId}`,
          actor: "seed:sponsors",
          type: "company.created",
          subjectId: advertiserId,
          reason: `Simulated sponsor ${s.name}: poster "${title}", agent on, ${`$${(s.dailyBudgetMinor / 100).toFixed(2)}`}/day`,
        });
        created.push(s.name);
        continue;
      }

      if (!s.youtubeUrl) throw new ConvexError({ code: "INVALID_INPUT", message: `${s.name}: missing youtubeUrl` });
      const parsed = parseYouTubeUrl(s.youtubeUrl);
      if (!parsed.ok) throw new ConvexError({ code: "INVALID_INPUT", message: `${s.name}: ${parsed.error}` });

      const campaignId = await ctx.db.insert("campaigns", {
        advertiserId,
        brief: `YouTube ad "${title}" by ${author}. ${s.summary}`.slice(0, 500),
        budgetMinor: s.dailyBudgetMinor * 30,
        currency: "USD",
        status: "active",
        creativeStatus: "approved",
        creativeContentType: YOUTUBE_CONTENT_TYPE,
        creativeSubmittedAt: now,
        creativeReviewReason: "Simulated sponsor: official ad from the company's own YouTube channel",
        targetAudience: s.targetAudience,
        audienceSource: "video",
      });
      await ctx.db.insert("youtubeCreatives", {
        campaignId,
        advertiserId,
        videoId: parsed.videoId,
        url: parsed.url,
        title,
        author,
        description: s.summary,
        thumbnailUrl: defaultThumbnailUrl(parsed.videoId),
        oembedStatus: "ok",
        fetchedAt: now,
        attachedAt: now,
      });
      const { maxPerSpotMinor, minRelevantViewers } = limitsFromBudget(s.dailyBudgetMinor);
      const { agentId } = await configureAgent(ctx, {
        campaign: (await ctx.db.get(campaignId))!,
        actor: "seed:sponsors",
        targetAudience: s.targetAudience,
        standing: { maxPricePerSpotMinor: maxPerSpotMinor, minRelevantViewers, dailyBudgetMinor: s.dailyBudgetMinor },
      });
      await ctx.db.patch(agentId, { autoTopUp: true });
      await requestResearch(ctx, advertiserId);
      await recordAudit(ctx, {
        traceId: `company:${advertiserId}`,
        actor: "seed:sponsors",
        type: "company.created",
        subjectId: advertiserId,
        reason: `Simulated sponsor ${s.name}: ad "${title}", agent on, ${`$${(s.dailyBudgetMinor / 100).toFixed(2)}`}/day`,
      });
      created.push(s.name);
    }
    return { created, existing };
  },
});

/** Sponsors seeded before auto top-up existed: turn it on. npx convex run sponsors:enableAutoTopUp */
export const enableAutoTopUp = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let n = 0;
    for (const s of SPONSORS) {
      const a = await ctx.db
        .query("advertisers")
        .withIndex("by_displayName", (q) => q.eq("displayName", s.name))
        .first();
      const agent = a
        ? await ctx.db
            .query("companyAgents")
            .withIndex("by_advertiser", (q) => q.eq("advertiserId", a._id))
            .first()
        : null;
      if (agent && !agent.autoTopUp) {
        await ctx.db.patch(agent._id, { autoTopUp: true });
        n++;
      }
    }
    return n;
  },
});
