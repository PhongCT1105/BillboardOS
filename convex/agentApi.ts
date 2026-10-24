import { ConvexError, v } from "convex/values";
import { env, internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { agentScope, audienceTags } from "./schema";
import {
  assertWithinBudget,
  authenticateAgent,
  committedMinor,
  requireAgentCampaign,
} from "./lib/agentKeys";
import { computeScreenPrice } from "./lib/screenPrice";
import { minNextBid } from "./lib/auction";
import { MAX_KEY_LENGTH } from "./lib/constants";
import { createQuoteCore, quoteResult } from "./quotes";
import { createHoldCore, holdResult } from "./holds";
import { bidCore, joinCore, joinResult, myStatusCore, myStatusResult, setAutoBidCore } from "./auctions";
import { rankScreens } from "./billboards";
import { alertPayload, webhookPayload } from "./watchDelivery";

/**
 * Agent HTTP API back end (ADR 0004). One internal mutation per endpoint; the
 * HTTP routes in http.ts only parse JSON and map errors. Every call
 * authenticates the agent key (scope, revocation, expiry, rate limit,
 * lastUsedAt) and then runs the SAME business functions as the signed-in
 * customer path (createQuoteCore, createHoldCore, joinCore, ...).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const MAX_SCREENS = 5;
const MAX_SLOTS_PER_SCREEN = 24;
const MAX_ALERTS = 50;

/** Parse an id from untrusted input: unknown or malformed -> NOT_FOUND (never a validator 500). */
function idOf<T extends TableNames>(ctx: MutationCtx, table: T, value: string, label: string): Id<T> {
  const id = ctx.db.normalizeId(table, value);
  if (!id) throw new ConvexError({ code: "NOT_FOUND", message: `${label} not found` });
  return id;
}

const bidOutcome = v.object({
  leading: v.boolean(),
  leaderLabel: v.union(v.string(), v.null()),
  currentMinor: v.number(),
  minNextBidMinor: v.number(),
  endsAt: v.number(),
});

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

/** GET /api/agent/inventory: recommended screens and their upcoming available slots with screen prices. */
export const inventory = internalMutation({
  args: {
    token: v.string(),
    campaignId: v.optional(v.string()),
    billboardId: v.optional(v.string()),
    hours: v.optional(v.number()),
  },
  returns: v.object({
    generatedAt: v.number(),
    campaignId: v.union(v.id("campaigns"), v.null()),
    screens: v.array(
      v.object({
        billboardId: v.id("billboards"),
        /** Host workspace: its seller agent lives at /a2a/hosts/{workspaceId} on the x402 server (ADR 0005). */
        workspaceId: v.union(v.id("workspaces"), v.null()),
        name: v.string(),
        city: v.string(),
        locationLabel: v.string(),
        matchScore: v.union(v.number(), v.null()),
        expectedAudiencePer15Min: v.number(),
        audienceBasis: v.union(v.literal("measured"), v.literal("normal_traffic")),
        relevantViewersPer15Min: v.number(),
        explanation: v.string(),
        slots: v.array(
          v.object({
            slotId: v.id("slots"),
            startAt: v.number(),
            endAt: v.number(),
            /** Screen price (before any account pricing on the quote). */
            screenPriceMinor: v.number(),
            auction: v.union(
              v.null(),
              v.object({ auctionId: v.id("auctions"), currentMinor: v.number(), minNextBidMinor: v.number(), endsAt: v.number() }),
            ),
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, null);
    const now = Date.now();
    const hours = args.hours ?? 12;
    if (!Number.isFinite(hours) || hours < 1 || hours > 24) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "hours must be between 1 and 24" });
    }
    let campaign: Doc<"campaigns"> | null = null;
    if (args.campaignId) {
      campaign = await requireAgentCampaign(ctx, agent, idOf(ctx, "campaigns", args.campaignId, "Campaign"));
    }
    let ranked = await rankScreens(ctx.db, campaign?.targetAudience, now);
    if (args.billboardId) {
      const billboardId = idOf(ctx, "billboards", args.billboardId, "Billboard");
      ranked = ranked.filter((r) => r.billboardId === billboardId);
    }
    const screens = [];
    for (const r of ranked.slice(0, MAX_SCREENS)) {
      const billboard = (await ctx.db.get(r.billboardId))!;
      const upcoming = await ctx.db
        .query("slots")
        .withIndex("by_billboard_and_startAt", (q) =>
          q.eq("billboardId", r.billboardId).gt("startAt", now + 5 * MIN).lte("startAt", now + hours * HOUR),
        )
        .take(4 * 24);
      const available = upcoming.filter((s) => s.state === "available").slice(0, MAX_SLOTS_PER_SCREEN);
      const prices =
        available.length > 0
          ? (await computeScreenPrice(ctx.db, billboard, available, now, { excludeCampaignId: campaign?._id })).price.slotPrices
          : [];
      const slots = [];
      for (let i = 0; i < available.length; i++) {
        const s = available[i];
        const auction = s.auctionId ? await ctx.db.get(s.auctionId) : null;
        slots.push({
          slotId: s._id,
          startAt: s.startAt,
          endAt: s.endAt,
          screenPriceMinor: prices[i].amountMinor,
          auction:
            auction && auction.status === "open"
              ? {
                  auctionId: auction._id,
                  currentMinor: auction.currentMinor,
                  minNextBidMinor: minNextBid(
                    { hasLeader: !!auction.leaderParticipantId, currentMinor: auction.currentMinor, reserveMinor: auction.reserveMinor },
                    auction.incrementRule,
                  ),
                  endsAt: auction.endsAt,
                }
              : null,
        });
      }
      screens.push({
        billboardId: r.billboardId,
        workspaceId: billboard.workspaceId ?? null,
        name: r.name,
        city: r.city,
        locationLabel: r.locationLabel,
        matchScore: r.matchScore,
        expectedAudiencePer15Min: r.expectedAudiencePer15Min,
        audienceBasis: r.audienceBasis,
        relevantViewersPer15Min: r.relevantViewersPer15Min,
        explanation: r.explanation,
        slots,
      });
    }
    return { generatedAt: now, campaignId: campaign?._id ?? null, screens };
  },
});

/** POST /api/agent/quotes (scope: quote) */
export const quote = internalMutation({
  args: { token: v.string(), campaignId: v.string(), slotIds: v.array(v.string()) },
  returns: quoteResult,
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "quote");
    const campaign = await requireAgentCampaign(ctx, agent, idOf(ctx, "campaigns", args.campaignId, "Campaign"));
    if (args.slotIds.length > 16) throw new ConvexError({ code: "INVALID_INPUT", message: "At most 16 slots" });
    const slotIds = args.slotIds.map((s) => idOf(ctx, "slots", s, "Slot"));
    return await createQuoteCore(ctx, { campaignId: campaign._id, slotIds, actor: agent.actor, agentKeyId: agent.key._id });
  },
});

/** POST /api/agent/holds (scope: hold). Counts against the key's budget cap. */
export const hold = internalMutation({
  args: { token: v.string(), quoteId: v.string(), idempotencyKey: v.string() },
  returns: holdResult,
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "hold");
    if (args.idempotencyKey.trim().length === 0 || args.idempotencyKey.length > MAX_KEY_LENGTH) {
      throw new ConvexError({ code: "INVALID_INPUT", message: `idempotencyKey must be 1..${MAX_KEY_LENGTH} characters` });
    }
    const quote = await ctx.db.get(idOf(ctx, "quotes", args.quoteId, "Quote"));
    if (!quote) throw new ConvexError({ code: "NOT_FOUND", message: "Quote not found" });
    await requireAgentCampaign(ctx, agent, quote.campaignId);
    const existing = await ctx.db
      .query("holds")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    // A retry of the same hold is free; anything new must fit the cap.
    if (!existing) await assertWithinBudget(ctx, agent.key, quote.amountMinor);
    return await createHoldCore(ctx, {
      quoteId: quote._id,
      idempotencyKey: args.idempotencyKey,
      actor: agent.actor,
      agentKeyId: agent.key._id,
    });
  },
});

/** POST /api/agent/auctions/{id}/join (scope: bid) */
export const auctionJoin = internalMutation({
  args: { token: v.string(), auctionId: v.string(), campaignId: v.string(), clientKey: v.optional(v.string()) },
  returns: joinResult,
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "bid");
    const campaign = await requireAgentCampaign(ctx, agent, idOf(ctx, "campaigns", args.campaignId, "Campaign"));
    return await joinCore(ctx, {
      auctionId: idOf(ctx, "auctions", args.auctionId, "Auction"),
      campaignId: campaign._id,
      clientKey: args.clientKey,
      agentKeyId: agent.key._id,
    });
  },
});

/** POST /api/agent/auctions/{id}/bid (scope: bid). The bid must fit the key's budget cap. */
export const auctionBid = internalMutation({
  args: { token: v.string(), auctionId: v.string(), campaignId: v.string(), bidderKey: v.string(), amountMinor: v.number() },
  returns: bidOutcome,
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "bid");
    const campaign = await requireAgentCampaign(ctx, agent, idOf(ctx, "campaigns", args.campaignId, "Campaign"));
    const auctionId = idOf(ctx, "auctions", args.auctionId, "Auction");
    await assertWithinBudget(ctx, agent.key, args.amountMinor, auctionId);
    return await bidCore(ctx, { auctionId, campaignId: campaign._id, bidderKey: args.bidderKey, amountMinor: args.amountMinor });
  },
});

/** POST /api/agent/auctions/{id}/auto-bid (scope: bid). The maximum must fit the key's budget cap. */
export const auctionAutoBid = internalMutation({
  args: { token: v.string(), auctionId: v.string(), campaignId: v.string(), bidderKey: v.string(), maxMinor: v.number() },
  returns: bidOutcome,
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "bid");
    const campaign = await requireAgentCampaign(ctx, agent, idOf(ctx, "campaigns", args.campaignId, "Campaign"));
    const auctionId = idOf(ctx, "auctions", args.auctionId, "Auction");
    await assertWithinBudget(ctx, agent.key, args.maxMinor, auctionId);
    return await setAutoBidCore(ctx, { auctionId, campaignId: campaign._id, bidderKey: args.bidderKey, maxMinor: args.maxMinor });
  },
});

/** GET /api/agent/auctions/{id}/status (scope: bid) */
export const auctionStatus = internalMutation({
  args: { token: v.string(), auctionId: v.string(), campaignId: v.string(), bidderKey: v.string() },
  returns: myStatusResult,
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, "bid");
    const campaign = await requireAgentCampaign(ctx, agent, idOf(ctx, "campaigns", args.campaignId, "Campaign"));
    return await myStatusCore(ctx, {
      auctionId: idOf(ctx, "auctions", args.auctionId, "Auction"),
      campaignId: campaign._id,
      bidderKey: args.bidderKey,
    });
  },
});

/** GET /api/agent/alerts?since=<ms>: unacknowledged alerts for the key's company, oldest first. */
export const alerts = internalMutation({
  args: { token: v.string(), since: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.object({ alerts: v.array(webhookPayload), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, null);
    if (args.since !== undefined && !Number.isFinite(args.since)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "since must be a timestamp in ms" });
    }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_ALERTS)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: `limit must be 1..${MAX_ALERTS}` });
    }
    const limit = args.limit ?? MAX_ALERTS;
    const since = args.since ?? 0;
    const rows = await ctx.db
      .query("alerts")
      .withIndex("by_advertiser_and_ackedAt_and_createdAt", (q) =>
        q.eq("advertiserId", agent.key.advertiserId).eq("ackedAt", undefined).gt("createdAt", since),
      )
      .take(limit * 4 + 1);
    const allowed = agent.key.campaignIds;
    const visible = allowed ? rows.filter((a) => allowed.includes(a.campaignId)) : rows;
    const base = env.CONVEX_SITE_URL ?? "";
    const out = [];
    for (const a of visible.slice(0, limit)) out.push(alertPayload(a, await ctx.db.get(a.billboardId), base));
    return { alerts: out, hasMore: visible.length > limit || rows.length > limit * 4 };
  },
});

/** POST /api/agent/alerts/{id}/ack: the agent has handled this alert (idempotent). */
export const ackAlert = internalMutation({
  args: { token: v.string(), alertId: v.string() },
  returns: v.object({ alertId: v.id("alerts"), ackedAt: v.number() }),
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, null);
    const alert = await ctx.db.get(idOf(ctx, "alerts", args.alertId, "Alert"));
    if (!alert || alert.advertiserId !== agent.key.advertiserId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Alert not found" });
    }
    if (agent.key.campaignIds && !agent.key.campaignIds.includes(alert.campaignId)) {
      throw new ConvexError({ code: "CAMPAIGN_NOT_ALLOWED", message: "This key is not allowed to act for that campaign" });
    }
    if (alert.ackedAt !== undefined) return { alertId: alert._id, ackedAt: alert.ackedAt };
    const ackedAt = Date.now();
    await ctx.db.patch(alert._id, { ackedAt });
    return { alertId: alert._id, ackedAt };
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
