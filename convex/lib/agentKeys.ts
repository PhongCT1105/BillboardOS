import { ConvexError, type Infer } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { agentScope } from "../schema";

/** SHA-256 hex of an agent key (only the hash is stored). */
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Agent keys (ADR 0004): a customer company lets its own buying agent act
 * for it over HTTP. Keys look like `bos_agent_<8 hex>_<48 hex>`; only the
 * SHA-256 hash is stored. Every call checks revocation, expiry, scope, the
 * campaign allowlist, a per-key rate limit and (for spending calls) the
 * budget cap: active holds + bookings from this key + leading auction bids.
 */

export type AgentScope = Infer<typeof agentScope>;
export const AGENT_SCOPES: AgentScope[] = ["quote", "hold", "bid", "pay"];
export const KEY_PREFIX = "bos_agent_";
export const RATE_LIMIT_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
const MAX_KEYS_SCANNED = 200;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh key, its public prefix, and a webhook signing secret. */
export async function generateAgentKey(): Promise<{ key: string; prefix: string; keyHash: string; webhookSecret: string }> {
  const prefix = `${KEY_PREFIX}${randomHex(4)}`;
  const key = `${prefix}_${randomHex(24)}`;
  return { key, prefix, keyHash: await hashKey(key), webhookSecret: `whsec_${randomHex(24)}` };
}

/** https only, except http://localhost / 127.0.0.1 for development. */
export function validWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export type AgentContext = {
  key: Doc<"agentKeys">;
  advertiser: Doc<"advertisers">;
  /** Audit identity: "agent:<company>/<key name>". */
  actor: string;
};

function fail(code: string, message: string, extra: Record<string, string | number> = {}): never {
  throw new ConvexError({ code, message, ...extra });
}

export function keyStatus(key: Doc<"agentKeys">, now: number): "active" | "revoked" | "expired" {
  if (key.revokedAt !== undefined) return "revoked";
  if (key.expiresAt <= now) return "expired";
  return "active";
}

/**
 * Authenticate a bearer key for one call. Mutation-only: it records
 * lastUsedAt and the rate-limit window. Throws INVALID_KEY, KEY_REVOKED,
 * KEY_EXPIRED, SCOPE_MISSING or RATE_LIMITED.
 */
export async function authenticateAgent(
  ctx: MutationCtx,
  token: string,
  scope: AgentScope | null,
): Promise<AgentContext> {
  if (!token.startsWith(KEY_PREFIX) || token.length > 200) fail("INVALID_KEY", "Missing or malformed agent key");
  const keyHash = await hashKey(token);
  const key = await ctx.db
    .query("agentKeys")
    .withIndex("by_hash", (q) => q.eq("keyHash", keyHash))
    .unique();
  if (!key) fail("INVALID_KEY", "Unknown agent key");
  const now = Date.now();
  const status = keyStatus(key, now);
  if (status === "revoked") fail("KEY_REVOKED", "This agent key was revoked");
  if (status === "expired") fail("KEY_EXPIRED", "This agent key has expired");
  if (scope && !key.scopes.includes(scope)) fail("SCOPE_MISSING", `This key lacks the "${scope}" scope`);

  const windowStart = key.rateWindowStart !== undefined && now - key.rateWindowStart < RATE_WINDOW_MS ? key.rateWindowStart : now;
  const count = windowStart === key.rateWindowStart ? (key.rateWindowCount ?? 0) + 1 : 1;
  if (count > RATE_LIMIT_PER_MINUTE) {
    fail("RATE_LIMITED", `More than ${RATE_LIMIT_PER_MINUTE} requests per minute`, {
      retryAfterMs: windowStart + RATE_WINDOW_MS - now,
    });
  }
  await ctx.db.patch(key._id, { lastUsedAt: now, rateWindowStart: windowStart, rateWindowCount: count });
  const advertiser = await ctx.db.get(key.advertiserId);
  if (!advertiser) fail("INVALID_KEY", "The company behind this key no longer exists");
  return { key, advertiser, actor: `agent:${advertiser.displayName}/${key.name}` };
}

/** The key may act for this campaign: same company, and inside its allowlist if it has one. */
export async function requireAgentCampaign(
  ctx: QueryCtx,
  agent: AgentContext,
  campaignId: Id<"campaigns">,
): Promise<Doc<"campaigns">> {
  const campaign = await ctx.db.get(campaignId);
  if (!campaign) fail("NOT_FOUND", "Campaign not found");
  if (campaign.advertiserId !== agent.key.advertiserId) {
    fail("NOT_COMPANY_MEMBER", "This key belongs to another company");
  }
  if (agent.key.campaignIds && !agent.key.campaignIds.includes(campaignId)) {
    fail("CAMPAIGN_NOT_ALLOWED", "This key is not allowed to act for that campaign");
  }
  return campaign;
}

/**
 * Money this key has committed: active and converted (booked) holds it took,
 * plus its currently-leading bids in open auctions (optionally excluding one
 * auction, when re-bidding in it).
 */
export async function committedMinor(
  ctx: QueryCtx,
  keyId: Id<"agentKeys">,
  excludeAuctionId?: Id<"auctions">,
): Promise<number> {
  let total = 0;
  for (const status of ["active", "converted"] as const) {
    const holds = await ctx.db
      .query("holds")
      .withIndex("by_agentKey_and_status", (q) => q.eq("agentKeyId", keyId).eq("status", status))
      .take(MAX_KEYS_SCANNED);
    total += holds.reduce((s, h) => s + h.amountMinor, 0);
  }
  const participations = await ctx.db
    .query("auctionParticipants")
    .withIndex("by_agentKey", (q) => q.eq("agentKeyId", keyId))
    .take(MAX_KEYS_SCANNED);
  for (const p of participations) {
    if (p.auctionId === excludeAuctionId) continue;
    const auction = await ctx.db.get(p.auctionId);
    if (auction?.status === "open" && auction.leaderParticipantId === p._id) total += auction.currentMinor;
  }
  return total;
}

/** Refuse a spend that would take the key past its cap (BUDGET_CAP). */
export async function assertWithinBudget(
  ctx: QueryCtx,
  key: Doc<"agentKeys">,
  additionalMinor: number,
  excludeAuctionId?: Id<"auctions">,
): Promise<void> {
  const committed = await committedMinor(ctx, key._id, excludeAuctionId);
  if (committed + additionalMinor > key.budgetCapMinor) {
    fail(
      "BUDGET_CAP",
      `This would commit $${((committed + additionalMinor) / 100).toFixed(2)}, over the key's cap of $${(key.budgetCapMinor / 100).toFixed(2)}`,
      { committedMinor: committed, budgetCapMinor: key.budgetCapMinor },
    );
  }
}
