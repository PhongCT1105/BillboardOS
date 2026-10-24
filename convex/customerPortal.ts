import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { bookingStatus, dataSource, invoiceStatus } from "./schema";
import { requireCustomer } from "./lib/tenancy";

/** Customer dashboard reads (ADR 0004): the company's own bookings and invoices only. */

const MAX_CAMPAIGNS = 50;
const MAX_BOOKINGS_PER_CAMPAIGN = 20;
const MAX_ROWS = 50;

export const bookings = query({
  args: { advertiserId: v.optional(v.id("advertisers")) },
  returns: v.array(
    v.object({
      bookingId: v.id("bookings"),
      createdAt: v.number(),
      campaignId: v.id("campaigns"),
      campaignBrief: v.string(),
      billboardName: v.string(),
      slotCount: v.number(),
      firstStartAt: v.union(v.number(), v.null()),
      lastEndAt: v.union(v.number(), v.null()),
      amountMinor: v.number(),
      status: bookingStatus,
      paidBy: v.union(v.literal("payment"), v.literal("invoice"), v.literal("unknown")),
      invoiceNumber: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx, args.advertiserId);
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(MAX_CAMPAIGNS);
    const rows: { booking: Doc<"bookings">; campaign: Doc<"campaigns"> }[] = [];
    for (const campaign of campaigns) {
      const list = await ctx.db
        .query("bookings")
        .withIndex("by_campaign_and_status", (q) => q.eq("campaignId", campaign._id))
        .order("desc")
        .take(MAX_BOOKINGS_PER_CAMPAIGN);
      for (const booking of list) rows.push({ booking, campaign });
    }
    rows.sort((a, b) => b.booking._creationTime - a.booking._creationTime);
    const out = [];
    const screens = new Map<string, string>();
    for (const { booking, campaign } of rows.slice(0, MAX_ROWS)) {
      if (!screens.has(booking.billboardId)) {
        screens.set(booking.billboardId, (await ctx.db.get(booking.billboardId))?.name ?? "Unknown screen");
      }
      const slots = [];
      for (const id of booking.slotIds.slice(0, 8)) {
        const s = await ctx.db.get(id);
        if (s) slots.push(s);
      }
      const invoice = booking.invoiceId ? await ctx.db.get(booking.invoiceId) : null;
      out.push({
        bookingId: booking._id,
        createdAt: booking._creationTime,
        campaignId: campaign._id,
        campaignBrief: campaign.brief,
        billboardName: screens.get(booking.billboardId)!,
        slotCount: booking.slotIds.length,
        firstStartAt: slots.length ? Math.min(...slots.map((s) => s.startAt)) : null,
        lastEndAt: slots.length ? Math.max(...slots.map((s) => s.endAt)) : null,
        amountMinor: booking.amountMinor,
        status: booking.status,
        paidBy: booking.paymentId ? ("payment" as const) : booking.invoiceId ? ("invoice" as const) : ("unknown" as const),
        invoiceNumber: invoice?.number ?? null,
      });
    }
    return out;
  },
});

export const invoices = query({
  args: { advertiserId: v.optional(v.id("advertisers")) },
  returns: v.array(
    v.object({
      invoiceId: v.id("invoices"),
      number: v.string(),
      description: v.string(),
      amountMinor: v.number(),
      balanceMinor: v.number(),
      status: invoiceStatus,
      issuedAt: v.number(),
      dueAt: v.number(),
      source: dataSource,
    }),
  ),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx, args.advertiserId);
    const rows = await ctx.db
      .query("invoices")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(MAX_ROWS);
    return rows.map((i) => ({
      invoiceId: i._id,
      number: i.number,
      description: i.description,
      amountMinor: i.amountMinor,
      balanceMinor: Math.max(0, i.amountMinor - i.paidMinor - i.adjustmentMinor - i.writtenOffMinor),
      status: i.status,
      issuedAt: i.issuedAt,
      dueAt: i.dueAt,
      source: i.source,
    }));
  },
});
