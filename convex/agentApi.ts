import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";
import { agentScope, audienceTags } from "./schema";
import { authenticateAgent, committedMinor, requireAgentCampaign } from "./lib/agentKeys";

/**
 * Agent HTTP API back end (ADR 0004). One internal mutation per endpoint; the
 * HTTP routes in http.ts only parse JSON and map errors. Every call
 * authenticates the agent key (scope, revocation, expiry, rate limit,
 * lastUsedAt). Agents buy through rounds (rounds.submitBid): the host offers
 * the spot on air, the agent accepts, counters or passes, then pays over x402.
 */

/** Parse an id from untrusted input: unknown or malformed -> NOT_FOUND (never a validator 500). */
function idOf<T extends TableNames>(ctx: MutationCtx, table: T, value: string, label: string): Id<T> {
  const id = ctx.db.normalizeId(table, value);
  if (!id) throw new ConvexError({ code: "NOT_FOUND", message: `${label} not found` });
  return id;
}

/** GET /api/agent/me */
export const me = internalMutation({
  args: { token: v.string() },
  returns: v.object({
    company: v.object({ advertiserId: v.id("advertisers"), displayName: v.string() }),
    key: v.object({
      name: v.string(),
      prefix: v.string(),
      scopes: v.array(agentScope),
      budgetCapMinor: v.number(),
      committedMinor: v.number(),
      expiresAt: v.number(),
    }),
    campaigns: v.array(
      v.object({
        campaignId: v.id("campaigns"),
        brief: v.string(),
        budgetMinor: v.number(),
        status: v.string(),
        targetCity: v.union(v.string(), v.null()),
        targetAudience: v.union(audienceTags, v.null()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, null);
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", agent.key.advertiserId))
      .order("desc")
      .take(50);
    return {
      company: { advertiserId: agent.advertiser._id, displayName: agent.advertiser.displayName },
      key: {
        name: agent.key.name,
        prefix: agent.key.prefix,
        scopes: agent.key.scopes,
        budgetCapMinor: agent.key.budgetCapMinor,
        committedMinor: await committedMinor(ctx, agent.key._id),
        expiresAt: agent.key.expiresAt,
      },
      campaigns: campaigns
        .filter((c) => !agent.key.campaignIds || agent.key.campaignIds.includes(c._id))
        .map((c) => ({
          campaignId: c._id,
          brief: c.brief,
          budgetMinor: c.budgetMinor,
          status: c.status,
          targetCity: c.targetCity ?? null,
          targetAudience: c.targetAudience ?? null,
        })),
    };
  },
});

/**
 * x402 server -> Convex (bearer INTERNAL_API_SECRET): may this agent key pay
 * this hold? Requires the `pay` scope and the hold's company (and allowlist).
 */
export const verifyPayment = internalMutation({
  args: { token: v.string(), holdId: v.string() },
  returns: v.object({
    agentKeyId: v.id("agentKeys"),
    advertiserId: v.id("advertisers"),
    actor: v.string(),
    holdId: v.id("holds"),
  }),
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "pay");
    const hold = await ctx.db.get(idOf(ctx, "holds", args.holdId, "Hold"));
    if (!hold) throw new ConvexError({ code: "NOT_FOUND", message: "Hold not found" });
    const quote = await ctx.db.get(hold.quoteId);
    if (!quote) throw new ConvexError({ code: "NOT_FOUND", message: "Quote not found" });
    await requireAgentCampaign(ctx, agent, quote.campaignId);
    return { agentKeyId: agent.key._id, advertiserId: agent.key.advertiserId, actor: agent.actor, holdId: hold._id };
  },
});
