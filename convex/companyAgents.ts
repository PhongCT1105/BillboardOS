import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { audienceTags, standingInstructions } from "./schema";
import { issueAgentKey } from "./agentKeys";
import { recordAudit } from "./lib/audit";
import { encryptSecret } from "./lib/demoCrypto";
import { keyStatus } from "./lib/agentKeys";
import { validateTags } from "./lib/match";
import { campaignsReadyFor, spentTodayForAdvertiserMinor, validateStanding, type Standing } from "./lib/sale";
import { requireCampaignAccess, requireCustomer, resolveWorkspace } from "./lib/tenancy";
import { signWebhook } from "./lib/webhook";
import { budgetProblem, limitsFromBudget } from "./lib/companyAgent";
import { isYouTubeCreative, parseYouTubeUrl } from "./lib/youtube";
import { attachYouTubeCreative } from "./creatives";
import { youtubeOf } from "./creativeReview";
import { oembedStatus } from "./schemaParts/knowledge";
import { researchMethod } from "./schemaParts/sales";
import { requestResearch, researchOf } from "./research";

/**
 * Company agents (spec "Accounts, wallets and agents"): each advertiser sets
 * up a bidding agent on the website and our server runs it. It behaves like
 * an external agent: it receives our signed webhooks at
 * /company-agents/{advertiserId}/webhook, replies and bids over the real agent
 * API with its own key, and pays over the real x402 route from its own Base
 * Sepolia CDP wallet (`co-<advertiserId>`). The plaintext key is stored
 * AES-GCM encrypted and never returned by any query. The acting half is in
 * companyAgentsAct.ts (announce, bid, counter; V8) and companyAgentsNode.ts
 * (wallet calls and the x402 payment; Node).
 */

const MAX_SKEW_MS = 5 * 60_000;
const KEY_NAME = "Company agent";
const KEY_DAYS = 365;
const MAX_BUDGET_MINOR = 10_000_000;
const TOP_UPS_PER_DAY = 5;
const TOP_UP_MINOR = 200;
const FAUCET_EVERY_MS = 24 * 60 * 60_000;
const MAX_CAMPAIGNS_SCANNED = 20;
const VIDEO_CAMPAIGN_BUDGET_MINOR = 5000;
/** Placeholder audience until the research agent has read the company. */
const STARTER_AUDIENCE: Record<string, number> = { startups: 0.5, software: 0.5 };

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

async function agentOf(ctx: QueryCtx, advertiserId: Id<"advertisers">): Promise<Doc<"companyAgents"> | null> {
  return await ctx.db
    .query("companyAgents")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .first();
}

/** Revoke the agent's current key (idempotent). */
async function revokeKey(ctx: MutationCtx, agentKeyId: Id<"agentKeys">, actor: string, why: string): Promise<void> {
  const key = await ctx.db.get(agentKeyId);
  if (!key || key.revokedAt !== undefined) return;
  await ctx.db.patch(key._id, { revokedAt: Date.now() });
  await recordAudit(ctx, {
    traceId: `company:${key.advertiserId}`,
    actor,
    type: "agent_key.revoked",
    subjectId: key._id,
    reason: `Agent key "${key.name}" (${key.prefix}) revoked: ${why}`,
  });
}

/**
 * Issue the agent a fresh key (quote, hold, bid, pay) for this campaign, with
 * our webhook and the company's standing limits, and seal it for storage.
 */
async function issueSealedKey(
  ctx: MutationCtx,
  input: { advertiserId: Id<"advertisers">; campaignId: Id<"campaigns">; standing: Standing; actor: string },
): Promise<{ agentKeyId: Id<"agentKeys">; keyCiphertext: string; keyIv: string }> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) fail("NOT_CONFIGURED", "INTERNAL_API_SECRET is not set: company agents can't store their keys");
  const site = process.env.CONVEX_SITE_URL?.replace(/\/$/, "");
  if (!site) fail("NOT_CONFIGURED", "CONVEX_SITE_URL is not set: company agents have no webhook");
  const issued = await issueAgentKey(ctx, {
    advertiserId: input.advertiserId,
    name: KEY_NAME,
    scopes: ["quote", "hold", "bid", "pay"],
    campaignIds: [input.campaignId],
    budgetCapMinor: Math.min(MAX_BUDGET_MINOR, input.standing.dailyBudgetMinor * KEY_DAYS),
    expiresInDays: KEY_DAYS,
    webhookUrl: `${site}/company-agents/${input.advertiserId}/webhook`,
    createdBy: input.actor,
  });
  await ctx.db.patch(issued.agentKeyId, { standing: input.standing });
  const sealed = await encryptSecret(secret, issued.key);
  return { agentKeyId: issued.agentKeyId, keyCiphertext: sealed.ciphertext, keyIv: sealed.iv };
}

// ---------------------------------------------------------------- website (company members)

/** Set up (or reconfigure) the company's agent: profile, reach target, limits; a fresh key; its wallet. */
export const setup = mutation({
  args: {
    campaignId: v.id("campaigns"),
    targetAudience: audienceTags,
    minRelevantViewers: v.number(),
    maxPerSpotMinor: v.number(),
    dailyBudgetMinor: v.number(),
  },
  returns: v.object({ agentId: v.id("companyAgents") }),
  handler: async (ctx, args) => {
    const { campaign, customer } = await requireCampaignAccess(ctx, args.campaignId);
    return await configureAgent(ctx, {
      campaign,
      actor: customer.actor,
      targetAudience: args.targetAudience,
      standing: { maxPricePerSpotMinor: args.maxPerSpotMinor, minRelevantViewers: args.minRelevantViewers, dailyBudgetMinor: args.dailyBudgetMinor },
    });
  },
});

/**
 * The marketer's whole setup: paste the ad video and pick a daily limit.
 * The video becomes the campaign's ad; reading it builds the company's card,
 * whose audience is the campaign's ICP from then on (audienceSource "video").
 * Per-spot max and reach target follow from the budget.
 */
export const quickSetup = mutation({
  args: { videoUrl: v.string(), dailyBudgetMinor: v.number() },
  returns: v.object({ agentId: v.id("companyAgents"), campaignId: v.id("campaigns") }),
  handler: async (ctx, args) => {
    const parsed = parseYouTubeUrl(args.videoUrl);
    if (!parsed.ok) fail("INVALID_INPUT", parsed.error);
    const budget = budgetProblem(args.dailyBudgetMinor);
    if (budget) fail("INVALID_INPUT", budget);
    const customer = await requireCustomer(ctx);
    const campaign = await campaignForVideo(ctx, customer.advertiserId);
    const current = await youtubeOf(ctx, campaign._id);
    // The same video again (e.g. only the budget moved) keeps its review and approvals.
    if (!isYouTubeCreative(campaign) || current?.videoId !== parsed.videoId) {
      await attachYouTubeCreative(ctx, campaign, customer.actor, parsed);
    }
    await ctx.db.patch(campaign._id, { audienceSource: "video" });
    // Until the research agent has read the video, start from what it knew (or the campaign's guess).
    const research = await researchOf(ctx, customer.advertiserId);
    const fromResearch = research && !validateTags(research.audienceTags) ? research.audienceTags : null;
    const targetAudience = fromResearch ?? campaign.targetAudience ?? STARTER_AUDIENCE;
    await requestResearch(ctx, customer.advertiserId);
    const { maxPerSpotMinor, minRelevantViewers } = limitsFromBudget(args.dailyBudgetMinor);
    const { agentId } = await configureAgent(ctx, {
      campaign: (await ctx.db.get(campaign._id))!,
      actor: customer.actor,
      targetAudience,
      standing: { maxPricePerSpotMinor: maxPerSpotMinor, minRelevantViewers, dailyBudgetMinor: args.dailyBudgetMinor },
    });
    return { agentId, campaignId: campaign._id };
  },
});

/** The campaign the video goes on: the agent's, else the newest open one, else a new one. Never a locked (operator-approved) one. */
async function campaignForVideo(ctx: MutationCtx, advertiserId: Id<"advertisers">): Promise<Doc<"campaigns">> {
  const usable = (c: Doc<"campaigns"> | null): c is Doc<"campaigns"> =>
    c !== null && c.advertiserId === advertiserId && c.status === "active" && c.creativeStatus !== "approved";
  const agent = await agentOf(ctx, advertiserId);
  const mine = agent ? await ctx.db.get(agent.campaignId) : null;
  if (usable(mine)) return mine;
  const recent = await ctx.db
    .query("campaigns")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .order("desc")
    .take(MAX_CAMPAIGNS_SCANNED);
  const found = recent.find(usable);
  if (found) return found;
  const campaignId = await ctx.db.insert("campaigns", {
    advertiserId,
    brief: "YouTube ad",
    budgetMinor: VIDEO_CAMPAIGN_BUDGET_MINOR,
    currency: "USD",
    status: "active",
    creativeStatus: "none",
    audienceSource: "video",
  });
  return (await ctx.db.get(campaignId))!;
}

/** Set up (or reconfigure) a company's built-in agent: a fresh sealed key with these limits, and its wallet. */
export async function configureAgent(
  ctx: MutationCtx,
  input: { campaign: Doc<"campaigns">; actor: string; targetAudience: Record<string, number>; standing: Standing },
): Promise<{ agentId: Id<"companyAgents"> }> {
  const { campaign, actor, standing } = input;
  const tagProblem = validateTags(input.targetAudience);
  if (tagProblem) fail("INVALID_INPUT", tagProblem);
  const problem = validateStanding(standing);
  if (problem) fail("INVALID_INPUT", problem);
  const advertiserId = campaign.advertiserId;
  await ctx.db.patch(campaign._id, { targetAudience: input.targetAudience });

  const existing = await agentOf(ctx, advertiserId);
  if (existing) await revokeKey(ctx, existing.agentKeyId, actor, "company agent reconfigured");
  const sealed = await issueSealedKey(ctx, { advertiserId, campaignId: campaign._id, standing, actor });
  let agentId: Id<"companyAgents">;
  if (existing) {
    await ctx.db.patch(existing._id, { campaignId: campaign._id, ...sealed, enabled: true });
    agentId = existing._id;
  } else {
    agentId = await ctx.db.insert("companyAgents", {
      advertiserId,
      campaignId: campaign._id,
      ...sealed,
      walletName: `co-${advertiserId}`,
      enabled: true,
    });
  }
  await ctx.scheduler.runAfter(0, internal.companyAgentsNode.ensureWallet, { advertiserId });
  return { agentId };
}

export const setEnabled = mutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx);
    const agent = await agentOf(ctx, customer.advertiserId);
    if (!agent) fail("NOT_FOUND", "Set up your company agent first");
    const key = await ctx.db.get(agent.agentKeyId);
    if (!args.enabled) {
      await revokeKey(ctx, agent.agentKeyId, customer.actor, "company agent turned off");
      if (agent.enabled) await ctx.db.patch(agent._id, { enabled: false });
      return null;
    }
    if (agent.enabled && key && keyStatus(key, Date.now()) === "active") return null;
    if (!key?.standing) fail("NOT_FOUND", "Set up your company agent again: its limits are missing");
    if (key.revokedAt === undefined) await revokeKey(ctx, key._id, customer.actor, "company agent turned back on");
    const sealed = await issueSealedKey(ctx, {
      advertiserId: agent.advertiserId,
      campaignId: agent.campaignId,
      standing: { maxPricePerSpotMinor: key.standing.maxPricePerSpotMinor, minRelevantViewers: key.standing.minRelevantViewers, dailyBudgetMinor: key.standing.dailyBudgetMinor },
      actor: customer.actor,
    });
    await ctx.db.patch(agent._id, { ...sealed, enabled: true });
    await ctx.scheduler.runAfter(0, internal.companyAgentsNode.ensureWallet, { advertiserId: agent.advertiserId });
    return null;
  },
});

/** The company's agent as its members see it (no key, ever). */
export const mine = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      enabled: v.boolean(),
      campaignId: v.id("campaigns"),
      targetAudience: v.union(audienceTags, v.null()),
      standing: v.union(standingInstructions, v.null()),
      walletAddress: v.union(v.string(), v.null()),
      balanceMinor: v.union(v.number(), v.null()),
      spentTodayMinor: v.number(),
      lastAction: v.union(v.string(), v.null()),
      advertiserId: v.id("advertisers"),
      /** The ad video and what we read from it. */
      video: v.union(
        v.null(),
        v.object({
          videoId: v.string(),
          url: v.string(),
          title: v.union(v.string(), v.null()),
          author: v.union(v.string(), v.null()),
          thumbnailUrl: v.string(),
          description: v.union(v.string(), v.null()),
          status: oembedStatus,
        }),
      ),
      /** What the research agent learned: who the company sells to (matching) and its price factor. */
      profile: v.union(
        v.null(),
        v.object({
          summary: v.string(),
          category: v.string(),
          audienceTags: v.record(v.string(), v.number()),
          priceFactor: v.number(),
          reasoning: v.string(),
          method: researchMethod,
          updatedAt: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const customer = await requireCustomer(ctx);
    const agent = await agentOf(ctx, customer.advertiserId);
    if (!agent) return null;
    const key = await ctx.db.get(agent.agentKeyId);
    const campaign = await ctx.db.get(agent.campaignId);
    const yt = campaign && isYouTubeCreative(campaign) ? await youtubeOf(ctx, campaign._id) : null;
    const research = await researchOf(ctx, agent.advertiserId);
    return {
      advertiserId: agent.advertiserId,
      video: yt
        ? {
            videoId: yt.videoId,
            url: yt.url,
            title: yt.title ?? null,
            author: yt.author ?? null,
            thumbnailUrl: yt.thumbnailUrl,
            description: yt.description ?? null,
            status: yt.oembedStatus,
          }
        : null,
      profile: research
        ? {
            summary: research.summary,
            category: research.category,
            audienceTags: research.audienceTags,
            priceFactor: research.priceFactor,
            reasoning: research.reasoning,
            method: research.method,
            updatedAt: research.researchedAt,
          }
        : null,
      enabled: agent.enabled,
      campaignId: agent.campaignId,
      targetAudience: campaign?.targetAudience ?? null,
      standing: key?.standing ?? null,
      walletAddress: agent.walletAddress ?? null,
      balanceMinor: agent.balanceMinor ?? null,
      spentTodayMinor: await spentTodayForAdvertiserMinor(ctx, agent.advertiserId, Date.now()),
      lastAction: agent.lastAction ?? null,
    };
  },
});

/**
 * Count one top-up against the company's daily limit (shared by the company
 * and the host) and schedule it: "faucet" claims free test USDC, "operator"
 * transfers from the operator wallet (host only, R26).
 */
async function startTopUp(ctx: MutationCtx, agent: Doc<"companyAgents">, source: "faucet" | "operator"): Promise<void> {
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  const count = agent.topUpDay === day ? (agent.topUpCount ?? 0) : 0;
  if (count >= TOP_UPS_PER_DAY) fail("RATE_LIMITED", `At most ${TOP_UPS_PER_DAY} top-ups per day; try again tomorrow (UTC)`);
  await ctx.db.patch(agent._id, { topUpDay: day, topUpCount: count + 1 });
  await ctx.scheduler.runAfter(0, internal.companyAgentsNode.topUp, { advertiserId: agent.advertiserId, amountMinor: TOP_UP_MINOR, source });
}

/**
 * Ask for test USDC for the agent's wallet: a free claim from the CDP faucet,
 * never the operator wallet (R26: only the host moves operator money). 5 a day.
 */
export const requestTopUp = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const customer = await requireCustomer(ctx);
    const agent = await agentOf(ctx, customer.advertiserId);
    if (!agent) fail("NOT_FOUND", "Set up your company agent first");
    await startTopUp(ctx, agent, "faucet");
    return null;
  },
});

/** Companies with a company agent whose creative this host has approved (the host's demo companies). */
async function hostCompanies(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Doc<"companyAgents">[]> {
  const seen = new Set<Id<"advertisers">>();
  const out: Doc<"companyAgents">[] = [];
  for (const campaign of await campaignsReadyFor(ctx, workspaceId)) {
    if (seen.has(campaign.advertiserId)) continue;
    seen.add(campaign.advertiserId);
    const agent = await agentOf(ctx, campaign.advertiserId);
    if (agent) out.push(agent);
  }
  return out;
}

/** Host: the companies with agents (an ad ready on its screens) and their wallet balances, for the presenter's top-up control. */
export const hostList = query({
  args: {},
  returns: v.array(
    v.object({
      advertiserId: v.id("advertisers"),
      company: v.string(),
      balanceMinor: v.union(v.number(), v.null()),
      walletAddress: v.union(v.string(), v.null()),
      enabled: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const me = await resolveWorkspace(ctx);
    const out = [];
    for (const agent of await hostCompanies(ctx, me.workspaceId)) {
      out.push({
        advertiserId: agent.advertiserId,
        company: (await ctx.db.get(agent.advertiserId))?.displayName ?? "Company",
        balanceMinor: agent.balanceMinor ?? null,
        walletAddress: agent.walletAddress ?? null,
        enabled: agent.enabled,
      });
    }
    return out;
  },
});

/**
 * Host: top up a company agent's wallet from the operator wallet (faucet when
 * it is short). Workspace members only; the company's same daily limit.
 */
export const hostTopUp = mutation({
  args: { advertiserId: v.id("advertisers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx);
    const agent = (await hostCompanies(ctx, me.workspaceId)).find((a) => a.advertiserId === args.advertiserId);
    if (!agent) fail("NOT_FOUND", "That company has no agent at this host");
    await startTopUp(ctx, agent, "operator");
    return null;
  },
});

// ---------------------------------------------------------------- the agent process (internal)

/** Constant-time comparison of two hex signatures. */
function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a webhook like an external receiver would: HMAC over
 * "<timestamp>.<raw body>" with the agent key's webhook secret, and a fresh
 * timestamp. Returns the company on success.
 */
export const verifyWebhook = internalQuery({
  args: { advertiserId: v.string(), timestamp: v.string(), signature: v.string(), body: v.string() },
  returns: v.union(v.object({ ok: v.literal(true), advertiserId: v.id("advertisers") }), v.object({ ok: v.literal(false), reason: v.string() })),
  handler: async (ctx, args) => {
    const advertiserId = ctx.db.normalizeId("advertisers", args.advertiserId);
    const agent = advertiserId ? await agentOf(ctx, advertiserId) : null;
    if (!agent) return { ok: false as const, reason: "unknown company agent" };
    if (!agent.enabled) return { ok: false as const, reason: "company agent is off" };
    const key = await ctx.db.get(agent.agentKeyId);
    if (!key) return { ok: false as const, reason: "unknown company agent" };
    const ts = Number(args.timestamp);
    if (!/^\d{1,16}$/.test(args.timestamp) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) return { ok: false as const, reason: "stale timestamp" };
    const expected = await signWebhook(key.webhookSecret, args.timestamp, args.body);
    if (!sameSignature(expected, args.signature)) return { ok: false as const, reason: "bad signature" };
    return { ok: true as const, advertiserId: agent.advertiserId };
  },
});

/** Accept a verified webhook and let the agent act on it asynchronously (the webhook returns at once). */
export const enqueue = internalMutation({
  args: { advertiserId: v.id("advertisers"), payload: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // V8, not Node (R25): no cold start between the announce and the 2 s join window.
    await ctx.scheduler.runAfter(0, internal.companyAgentsAct.act, { advertiserId: args.advertiserId, payload: args.payload });
    return null;
  },
});

/**
 * What the agent needs to act (internal only; ciphertext, never the key):
 * its limits, today's spend, the cached balance and, given an offer of its
 * own, the spot's value and its audience match (everything `agentCap` needs).
 */
export const forAct = internalQuery({
  args: { advertiserId: v.id("advertisers"), now: v.number(), holdId: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      enabled: v.boolean(),
      keyCiphertext: v.string(),
      keyIv: v.string(),
      walletName: v.string(),
      walletAddress: v.union(v.string(), v.null()),
      company: v.string(),
      standing: v.union(standingInstructions, v.null()),
      spentTodayMinor: v.number(),
      balanceMinor: v.union(v.number(), v.null()),
      /** Given a hold this company's agent took: can it still be paid? */
      holdActive: v.union(v.boolean(), v.null()),
      /** What the research agent knows about this company (the LLM agent reasons with it). */
      research: v.union(v.null(), v.object({ summary: v.string(), category: v.string(), priceFactor: v.number() })),
      autoTopUp: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const agent = await agentOf(ctx, args.advertiserId);
    if (!agent) return null;
    const key = await ctx.db.get(agent.agentKeyId);
    const company = (await ctx.db.get(agent.advertiserId))?.displayName ?? "company";
    const holdId = args.holdId ? ctx.db.normalizeId("holds", args.holdId) : null;
    const hold = holdId ? await ctx.db.get(holdId) : null;
    const holdKey = hold?.agentKeyId ? await ctx.db.get(hold.agentKeyId) : null;
    const holdActive = !args.holdId ? null : hold !== null && holdKey?.advertiserId === agent.advertiserId && hold.status === "active" && hold.expiresAt > args.now;
    return {
      enabled: agent.enabled,
      keyCiphertext: agent.keyCiphertext,
      keyIv: agent.keyIv,
      walletName: agent.walletName,
      walletAddress: agent.walletAddress ?? null,
      company,
      standing: key?.standing ?? null,
      spentTodayMinor: await spentTodayForAdvertiserMinor(ctx, agent.advertiserId, args.now),
      balanceMinor: agent.balanceMinor ?? null,
      holdActive,
      research: await researchOf(ctx, agent.advertiserId).then((r) => (r ? { summary: r.summary, category: r.category, priceFactor: r.priceFactor } : null)),
      autoTopUp: agent.autoTopUp === true,
    };
  },
});

export const logAction = internalMutation({
  args: { advertiserId: v.id("advertisers"), action: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const agent = await agentOf(ctx, args.advertiserId);
    if (agent) await ctx.db.patch(agent._id, { lastAction: args.action.slice(0, 300), lastActionAt: Date.now() });
    return null;
  },
});

/** The wallet's address and on-chain USDC balance (cents), as last read. */
export const setWallet = internalMutation({
  args: { advertiserId: v.id("advertisers"), walletAddress: v.string(), balanceMinor: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const agent = await agentOf(ctx, args.advertiserId);
    if (agent) await ctx.db.patch(agent._id, { walletAddress: args.walletAddress, balanceMinor: args.balanceMinor, balanceAt: Date.now() });
    return null;
  },
});

/**
 * Take this company's one automatic faucet claim for the next 24 h (the CDP
 * faucet allows about 10 USDC a day for the whole project). Atomic, so
 * repeated setups or off/on toggles can't claim twice. True when taken.
 */
export const claimFaucetSlot = internalMutation({
  args: { advertiserId: v.id("advertisers") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const agent = await agentOf(ctx, args.advertiserId);
    const now = Date.now();
    if (!agent || (agent.faucetClaimedAt !== undefined && now - agent.faucetClaimedAt < FAUCET_EVERY_MS)) return false;
    await ctx.db.patch(agent._id, { faucetClaimedAt: now });
    return true;
  },
});
