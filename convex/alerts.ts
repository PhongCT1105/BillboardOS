import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { alertSlot, alertTrigger, deliveryStatus } from "./schema";
import { requireCustomer } from "./lib/tenancy";

/** Customer alert inbox (ADR 0004). Live via useQuery; newest first. */

const UNREAD_COUNT_CAP = 100;
const MARK_ALL_BATCH = 200;

export const alertView = v.object({
  alertId: v.id("alerts"),
  /** Null for flash offers (no watch rule). */
  ruleId: v.union(v.id("watchRules"), v.null()),
  ruleName: v.string(),
  flashOfferId: v.union(v.id("flashOffers"), v.null()),
  campaignId: v.id("campaigns"),
  trigger: alertTrigger,
  billboardId: v.id("billboards"),
  billboardName: v.string(),
  city: v.string(),
  slots: v.array(alertSlot),
  matchCount: v.number(),
  priceMinor: v.number(),
  auctionId: v.union(v.id("auctions"), v.null()),
  reason: v.string(),
  createdAt: v.number(),
  read: v.boolean(),
  agent: v.union(
    v.object({ status: deliveryStatus, attempts: v.number(), lastError: v.union(v.string(), v.null()) }),
    v.null(),
  ),
});

export const inbox = query({
  args: { advertiserId: v.optional(v.id("advertisers")), limit: v.optional(v.number()) },
  returns: v.object({ alerts: v.array(alertView), unreadCount: v.number(), unreadCapped: v.boolean() }),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx, args.advertiserId);
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 30)));
    const rows = await ctx.db
      .query("alerts")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(limit);
    const unread = await ctx.db
      .query("alerts")
      .withIndex("by_advertiser_and_readAt", (q) => q.eq("advertiserId", customer.advertiserId).eq("readAt", undefined))
      .take(UNREAD_COUNT_CAP);
    const names = new Map<string, { name: string; city: string }>();
    const ruleNames = new Map<string, string>();
    const alerts = [];
    for (const a of rows) {
      if (!names.has(a.billboardId)) {
        const b = await ctx.db.get(a.billboardId);
        names.set(a.billboardId, { name: b?.name ?? "Unknown screen", city: b?.city ?? "" });
      }
      const ruleKey = a.ruleId ?? "flash";
      if (!ruleNames.has(ruleKey)) {
        const r = a.ruleId ? await ctx.db.get(a.ruleId) : null;
        ruleNames.set(ruleKey, a.ruleId ? (r?.name ?? "Deleted rule") : "Seller agent flash offer");
      }
      const screen = names.get(a.billboardId)!;
      alerts.push({
        alertId: a._id,
        ruleId: a.ruleId ?? null,
        ruleName: ruleNames.get(ruleKey)!,
        flashOfferId: a.flashOfferId ?? null,
        campaignId: a.campaignId,
        trigger: a.trigger,
        billboardId: a.billboardId,
        billboardName: screen.name,
        city: screen.city,
        slots: a.slots,
        matchCount: a.matchCount,
        priceMinor: a.priceMinor,
        auctionId: a.auctionId ?? null,
        reason: a.reason,
        createdAt: a.createdAt,
        read: a.readAt !== undefined,
        agent: a.agent ? { status: a.agent.status, attempts: a.agent.attempts, lastError: a.agent.lastError ?? null } : null,
      });
    }
    return { alerts, unreadCount: unread.length, unreadCapped: unread.length >= UNREAD_COUNT_CAP };
  },
});

/** Mark one alert read, or (no alertId) every unread alert of the company. */
export const markRead = mutation({
  args: { alertId: v.optional(v.id("alerts")), advertiserId: v.optional(v.id("advertisers")) },
  returns: v.object({ marked: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.alertId) {
      const alert = await ctx.db.get(args.alertId);
      if (!alert) throw new ConvexError({ code: "NOT_FOUND", message: "Alert not found" });
      await requireCustomer(ctx, alert.advertiserId);
      if (alert.readAt !== undefined) return { marked: 0 };
      await ctx.db.patch(alert._id, { readAt: now });
      return { marked: 1 };
    }
    const customer = await requireCustomer(ctx, args.advertiserId);
    const unread = await ctx.db
      .query("alerts")
      .withIndex("by_advertiser_and_readAt", (q) => q.eq("advertiserId", customer.advertiserId).eq("readAt", undefined))
      .take(MARK_ALL_BATCH);
    for (const a of unread) await ctx.db.patch(a._id, { readAt: now });
    return { marked: unread.length };
  },
});
