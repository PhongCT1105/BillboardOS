import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { hasCreative } from "./youtube";

/**
 * Shared rules for selling the spot on air (rounds.ts): limits, budgets,
 * creatives and events. Integer cents.
 */

/** A spot needs at least this much time left to be sold. */
export const MIN_REMAINING_MS = 3 * 60_000;
/** The buyer has this long to pay after a deal. */
export const PAY_WINDOW_MS = 60_000;
/** Written on every quote a round creates. */
export const PRICING_POLICY_VERSION = "rounds-v2";

const DAY = 24 * 60 * 60_000;
const MAX_COMPANY_KEYS_SCANNED = 200;

/** A company agent's standing limits (what its key may spend). */
export type Standing = {
  maxPricePerSpotMinor: number;
  minRelevantViewers: number;
  dailyBudgetMinor: number;
  /** Legacy: kept so old rows validate; no new code writes it. */
  policy?: "auto_accept" | "counter" | "pass";
  counterRatio?: number;
};

export function validateStanding(s: Standing): string | null {
  if (!Number.isSafeInteger(s.maxPricePerSpotMinor) || s.maxPricePerSpotMinor <= 0 || s.maxPricePerSpotMinor > 10_000_000) {
    return "maxPricePerSpotMinor must be whole cents in (0, 10000000]";
  }
  if (!Number.isSafeInteger(s.minRelevantViewers) || s.minRelevantViewers < 0 || s.minRelevantViewers > 100_000) return "minRelevantViewers must be 0..100000";
  if (!Number.isSafeInteger(s.dailyBudgetMinor) || s.dailyBudgetMinor <= 0 || s.dailyBudgetMinor > 10_000_000) {
    return "dailyBudgetMinor must be whole cents in (0, 10000000]";
  }
  return null;
}

/** Server-side check of an offer against the agent's own standing limits. */
export function replyAllowed(s: Standing | undefined, amountMinor: number, spentTodayMinor: number): string | null {
  if (!s) return null;
  if (amountMinor > s.maxPricePerSpotMinor) return `over the key's standing max of $${(s.maxPricePerSpotMinor / 100).toFixed(2)} per spot`;
  if (spentTodayMinor + amountMinor > s.dailyBudgetMinor) return "over the company's daily budget";
  return null;
}

/** A settlement transaction hash (0x + 32 bytes hex), as opposed to a fallback payment reference. */
export const isTxHash = (ref: string) => /^0x[0-9a-fA-F]{64}$/.test(ref);

/** A campaign's creative can play on this host's screens: approved platform-wide or by this host. */
export async function creativeReady(ctx: QueryCtx, campaign: Doc<"campaigns">, workspaceId: Id<"workspaces"> | undefined): Promise<boolean> {
  // An uploaded file or a YouTube link (which has no storage file).
  if (!hasCreative(campaign)) return false;
  if (campaign.creativeStatus === "approved") return true;
  if (!workspaceId) return false;
  const approval = await ctx.db
    .query("creativeApprovals")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId).eq("campaignId", campaign._id))
    .first();
  return approval !== null;
}

const MAX_READY_SCANNED = 100;

/** Active campaigns whose ad can play on this host's screens: approved by this host, or approved for every host. */
export async function campaignsReadyFor(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Doc<"campaigns">[]> {
  const ready = new Map<Id<"campaigns">, Doc<"campaigns">>();
  const approvals = await ctx.db
    .query("creativeApprovals")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_READY_SCANNED);
  for (const a of approvals) {
    const c = await ctx.db.get(a.campaignId);
    if (c && c.status === "active" && hasCreative(c)) ready.set(c._id, c);
  }
  const platform = await ctx.db
    .query("campaigns")
    .withIndex("by_creativeStatus", (q) => q.eq("creativeStatus", "approved"))
    .take(MAX_READY_SCANNED);
  for (const c of platform) if (c.status === "active" && hasCreative(c)) ready.set(c._id, c);
  return [...ready.values()];
}

/** The host-entered event on this screen right now (the newest if several overlap), or null. */
export async function activeEvent(ctx: QueryCtx, billboardId: Id<"billboards">, now: number): Promise<Doc<"events"> | null> {
  const events = await ctx.db
    .query("events")
    .withIndex("by_billboard_and_startsAt", (q) => q.eq("billboardId", billboardId).gte("startsAt", now - DAY).lte("startsAt", now))
    .take(20);
  return events.filter((e) => e.endsAt > now).sort((a, b) => b._creationTime - a._creationTime)[0] ?? null;
}

/** Money one key committed in the last 24 h (active + converted holds). */
async function spentTodayMinor(ctx: QueryCtx, agentKeyId: Id<"agentKeys">, now: number): Promise<number> {
  let total = 0;
  for (const status of ["active", "converted"] as const) {
    const holds = await ctx.db
      .query("holds")
      .withIndex("by_agentKey_and_status", (q) => q.eq("agentKeyId", agentKeyId).eq("status", status))
      .order("desc")
      .take(200);
    for (const h of holds) if (h._creationTime >= now - DAY) total += h.amountMinor;
  }
  return total;
}

/**
 * Money a company committed in the last 24 h across all of its agent keys:
 * the daily budget's "spent". Per company, so a re-issued key never gets a
 * fresh daily budget.
 */
export async function spentTodayForAdvertiserMinor(ctx: QueryCtx, advertiserId: Id<"advertisers">, now: number): Promise<number> {
  const keys = await ctx.db
    .query("agentKeys")
    .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
    .order("desc")
    .take(MAX_COMPANY_KEYS_SCANNED);
  let total = 0;
  for (const k of keys) {
    if ((k.revokedAt !== undefined && k.revokedAt < now - DAY) || k.expiresAt < now - DAY) continue;
    total += await spentTodayMinor(ctx, k._id, now);
  }
  return total;
}
