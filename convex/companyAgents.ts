import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { audienceTags, standingInstructions } from "./schema";
import { issueAgentKey } from "./agentKeys";
import { spentTodayForAdvertiserMinor } from "./moments";
import { recordAudit } from "./lib/audit";
import { encryptSecret } from "./lib/demoCrypto";
import { keyStatus } from "./lib/agentKeys";
import { MAX_BIDS_PER_COMPANY } from "./lib/liveAuction";
import { validateTags } from "./lib/match";
import { validateStanding, type Standing } from "./lib/moment";
import { requireCampaignAccess, requireCustomer } from "./lib/tenancy";
import { signWebhook } from "./lib/webhook";
import { explorerTxUrl } from "./lib/x402/money";

/**
 * Company agents (spec "Accounts, wallets and agents"): each advertiser sets
 * up a bidding agent on the website and our server runs it. It behaves like
 * an external agent: it receives our signed webhooks at
 * /company-agents/{advertiserId}/webhook, replies and bids over the real agent
 * API with its own key, and pays over the real x402 route from its own Base
 * Sepolia CDP wallet (`co-<advertiserId>`). The plaintext key is stored
 * AES-GCM encrypted and never returned by any query. The acting half (wallet
 * calls, payment) is in companyAgentsNode.ts.
 */

const MAX_SKEW_MS = 5 * 60_000;
const KEY_NAME = "Company agent";
const KEY_DAYS = 365;
const MAX_BUDGET_MINOR = 10_000_000;
const TOP_UPS_PER_DAY = 5;
const TOP_UP_MINOR = 200;
const FEED_OFFERS = 10;
const MAX_BIDS_SCANNED = 100;
const FAUCET_EVERY_MS = 24 * 60 * 60_000;

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

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
    const tagProblem = validateTags(args.targetAudience);
    if (tagProblem) fail("INVALID_INPUT", tagProblem);
    const standing: Standing = {
      maxPricePerSpotMinor: args.maxPerSpotMinor,
      minRelevantViewers: args.minRelevantViewers,
      dailyBudgetMinor: args.dailyBudgetMinor,
    };
    const problem = validateStanding(standing);
    if (problem) fail("INVALID_INPUT", problem);
    const advertiserId = campaign.advertiserId;
    await ctx.db.patch(campaign._id, { targetAudience: args.targetAudience });

    const existing = await agentOf(ctx, advertiserId);
    if (existing) await revokeKey(ctx, existing.agentKeyId, customer.actor, "company agent reconfigured");
    const sealed = await issueSealedKey(ctx, { advertiserId, campaignId: campaign._id, standing, actor: customer.actor });
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
  },
});

/** Turn the agent off (its key is revoked at once) or back on (a fresh key, same limits). */
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
    }),
  ),
  handler: async (ctx) => {
    const customer = await requireCustomer(ctx);
    const agent = await agentOf(ctx, customer.advertiserId);
    if (!agent) return null;
    const key = await ctx.db.get(agent.agentKeyId);
    const campaign = await ctx.db.get(agent.campaignId);
    return {
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

const feedKind = v.union(
  v.literal("announce"),
  v.literal("bid"),
  v.literal("rival_bid"),
  v.literal("counter"),
  v.literal("won"),
  v.literal("lost"),
  v.literal("paid"),
  v.literal("blocked"),
);
const feedEntry = v.object({
  at: v.number(),
  kind: feedKind,
  text: v.string(),
  amountMinor: v.optional(v.number()),
  txUrl: v.optional(v.string()),
});
type FeedEntry = typeof feedEntry.type;

/**
 * The company's live feed, newest first: each announcement with its price
 * story, every bid (the rival is only ever "Another company"), counters, the
 * win or loss, and the payment (with its Basescan link) or why it was blocked.
 */
export const feed = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(feedEntry),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx);
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit ?? 50)));
    const offers = await ctx.db
      .query("flashOffers")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(FEED_OFFERS);
    const out: FeedEntry[] = [];
    for (const o of offers) {
      const m = await ctx.db.get(o.momentId);
      if (!m) continue;
      const billboard = await ctx.db.get(m.billboardId);
      const minutes = Math.round((m.spotEndAt - m.spotStartAt) / 60_000);
      out.push({
        at: o.sentAt,
        kind: "announce",
        text: `${billboard?.name ?? "A screen"}: ${minutes}-minute spot, bidding opens at ${usd(m.priceMinor)} (minimum ${usd(m.floorMinor)}), ~${o.relevantViewers} matching people in view. ${m.priceWhy ?? m.reasoning}`,
        amountMinor: m.priceMinor,
      });
      const bids = await ctx.db
        .query("momentBids")
        .withIndex("by_moment", (q) => q.eq("momentId", m._id))
        .take(MAX_BIDS_SCANNED);
      let myBids = 0;
      for (const b of bids) {
        const mine = b.offerId === o._id;
        if (b.kind === "bid" && mine) {
          myBids++;
          out.push({ at: b.at, kind: "bid", text: `You bid ${usd(b.amountMinor)} (bid ${myBids} of ${MAX_BIDS_PER_COMPANY})`, amountMinor: b.amountMinor });
        } else if (b.kind === "bid") {
          out.push({ at: b.at, kind: "rival_bid", text: `Another company bid ${usd(b.amountMinor)}`, amountMinor: b.amountMinor });
        } else if (b.kind === "buyer_offer" && mine) {
          out.push({ at: b.at, kind: "counter", text: `You offered ${usd(b.amountMinor)}`, amountMinor: b.amountMinor });
        } else if (b.kind === "seller_counter" && mine) {
          out.push({ at: b.at, kind: "counter", text: `The host countered at ${usd(b.amountMinor)}`, amountMinor: b.amountMinor });
        }
      }
      const hold = o.holdId ? await ctx.db.get(o.holdId) : null;
      if (hold) {
        out.push({ at: hold._creationTime, kind: "won", text: `You won the spot at ${usd(hold.amountMinor)}: pay within 60 s`, amountMinor: hold.amountMinor });
        const paid = m.winnerOfferId === o._id && (m.status === "paid" || m.status === "playing") && m.paymentTx;
        if (paid) {
          const settled = m.steps.find((s) => s.key === "settled");
          out.push({
            at: settled?.at ?? hold._creationTime,
            kind: "paid",
            text: `Paid ${usd(m.paidMinor ?? hold.amountMinor)} USDC from your wallet over x402`,
            amountMinor: m.paidMinor ?? hold.amountMinor,
            txUrl: explorerTxUrl(m.paymentNetwork ?? "", m.paymentTx!),
          });
        } else if (o.status === "defaulted" || (o.status === "won" && m.paymentBlocked)) {
          const blocked = m.steps.find((s) => s.key === "payment_blocked" && s.at >= hold._creationTime);
          out.push({
            at: blocked?.at ?? Math.min(hold.expiresAt, hold._creationTime + 60_000),
            kind: "blocked",
            text: blocked?.label ?? "Not paid within 60 s: the spot went to the next best offer",
            amountMinor: hold.amountMinor,
          });
        }
      }
      if (o.status === "lost") {
        const end = [...m.steps].reverse().find((s) => s.key === "winner" || s.key === "failed");
        out.push({ at: end?.at ?? m.startedAt, kind: "lost", text: m.status === "failed" ? "Nobody got this spot" : "Another company won this spot" });
      }
    }
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, limit);
  },
});

/** Ask for test USDC for the agent's wallet: a transfer from the operator wallet, else the faucet. 5 a day. */
export const requestTopUp = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const customer = await requireCustomer(ctx);
    const agent = await agentOf(ctx, customer.advertiserId);
    if (!agent) fail("NOT_FOUND", "Set up your company agent first");
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const count = agent.topUpDay === day ? (agent.topUpCount ?? 0) : 0;
    if (count >= TOP_UPS_PER_DAY) fail("RATE_LIMITED", `At most ${TOP_UPS_PER_DAY} top-ups per day; try again tomorrow (UTC)`);
    await ctx.db.patch(agent._id, { topUpDay: day, topUpCount: count + 1 });
    await ctx.scheduler.runAfter(0, internal.companyAgentsNode.topUp, { advertiserId: agent.advertiserId, amountMinor: TOP_UP_MINOR });
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
    await ctx.scheduler.runAfter(0, internal.companyAgentsNode.act, { advertiserId: args.advertiserId, payload: args.payload });
    return null;
  },
});

/**
 * What the agent needs to act (internal only; ciphertext, never the key):
 * its limits, today's spend, the cached balance and, given an offer of its
 * own, the spot's value and its audience match (everything `agentCap` needs).
 */
export const forAct = internalQuery({
  args: { advertiserId: v.id("advertisers"), now: v.number(), offerId: v.optional(v.string()), holdId: v.optional(v.string()) },
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
      offer: v.union(v.null(), v.object({ valueMinor: v.union(v.number(), v.null()), matchScore: v.number() })),
      /** Given a hold this company's agent took: can it still be paid? */
      holdActive: v.union(v.boolean(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const agent = await agentOf(ctx, args.advertiserId);
    if (!agent) return null;
    const key = await ctx.db.get(agent.agentKeyId);
    const company = (await ctx.db.get(agent.advertiserId))?.displayName ?? "company";
    const offerId = args.offerId ? ctx.db.normalizeId("flashOffers", args.offerId) : null;
    const offer = offerId ? await ctx.db.get(offerId) : null;
    const moment = offer && offer.advertiserId === agent.advertiserId ? await ctx.db.get(offer.momentId) : null;
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
      offer: offer && moment ? { valueMinor: moment.valueMinor ?? null, matchScore: offer.matchScore } : null,
      holdActive,
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
