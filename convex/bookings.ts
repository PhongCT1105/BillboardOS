import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { bookingStatus } from "./schema";
import { recordAudit } from "./lib/audit";
import { NET15_MS, nextInvoiceNumber } from "./lib/finance";
import { usd } from "./lib/reconcile";
import { scheduleBooking } from "./lib/scheduling";

/**
 * Book a held slot on credit for an advertiser on net15 terms: converts the
 * hold to a booking with no payment and issues an invoice due in 15 days.
 * Prepay/review advertisers must use the x402 / manual payment path.
 *
 * `idempotencyKey` is the key the hold was created with (proves the caller
 * holds it). Repeating the call returns the same booking + invoice.
 */
export const confirmOnTerms = mutation({
  args: { holdId: v.id("holds"), idempotencyKey: v.string() },
  returns: v.object({
    bookingId: v.id("bookings"),
    bookingStatus,
    invoiceId: v.id("invoices"),
    invoiceNumber: v.string(),
    amountMinor: v.number(),
    issuedAt: v.number(),
    dueAt: v.number(),
    replayed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const hold = await ctx.db.get(args.holdId);
    if (!hold) throw new ConvexError({ code: "NOT_FOUND", message: "Hold not found" });
    if (hold.idempotencyKey !== args.idempotencyKey) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Not the holder of this hold" });
    }

    const existing = await ctx.db
      .query("bookings")
      .withIndex("by_hold", (q) => q.eq("holdId", hold._id))
      .first();
    if (existing) {
      const invoice = existing.invoiceId ? await ctx.db.get(existing.invoiceId) : null;
      if (!invoice) {
        throw new ConvexError({
          code: "ALREADY_PAID",
          message: "This hold was already booked with a payment",
        });
      }
      return {
        bookingId: existing._id,
        bookingStatus: existing.status,
        invoiceId: invoice._id,
        invoiceNumber: invoice.number,
        amountMinor: invoice.amountMinor,
        issuedAt: invoice.issuedAt,
        dueAt: invoice.dueAt,
        replayed: true,
      };
    }

    const now = Date.now();
    if (hold.status !== "active" || now >= hold.expiresAt) {
      throw new ConvexError({
        code: "HOLD_NOT_ACTIVE",
        message: `Hold is ${hold.status === "active" ? "expired" : hold.status}`,
      });
    }
    const quote = await ctx.db.get(hold.quoteId);
    if (!quote) throw new ConvexError({ code: "NOT_FOUND", message: "Quote not found" });
    const campaign = await ctx.db.get(quote.campaignId);
    if (!campaign) throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found" });
    const advertiser = await ctx.db.get(campaign.advertiserId);
    if (!advertiser) throw new ConvexError({ code: "NOT_FOUND", message: "Advertiser not found" });
    if (advertiser.paymentTerms !== "net15") {
      throw new ConvexError({
        code: "TERMS_NOT_ALLOWED",
        message: `${advertiser.displayName} is on ${advertiser.paymentTerms} terms; pay up front instead`,
      });
    }
    for (const slotId of hold.slotIds) {
      const slot = await ctx.db.get(slotId);
      if (!slot || slot.state !== "held" || slot.holdId !== hold._id) {
        throw new ConvexError({ code: "HOLD_NOT_ACTIVE", message: `Slot ${slotId} is no longer held` });
      }
    }

    const bookingId = await ctx.db.insert("bookings", {
      holdId: hold._id,
      quoteId: hold.quoteId,
      campaignId: campaign._id,
      billboardId: hold.billboardId,
      slotIds: hold.slotIds,
      amountMinor: hold.amountMinor,
      currency: hold.currency,
      status: "confirmed",
      traceId: hold.traceId,
    });
    const number = await nextInvoiceNumber(ctx);
    const dueAt = now + NET15_MS;
    const invoiceId = await ctx.db.insert("invoices", {
      number,
      advertiserId: advertiser._id,
      campaignId: campaign._id,
      bookingId,
      description: `${hold.slotIds.length} x 15-min slot(s), quote ${quote._id}`,
      amountMinor: hold.amountMinor,
      currency: "USD",
      issuedAt: now,
      dueAt,
      status: "open",
      paidMinor: 0,
      adjustmentMinor: 0,
      writtenOffMinor: 0,
      source: "booking",
    });
    await ctx.db.patch(bookingId, { invoiceId });
    for (const slotId of hold.slotIds) {
      await ctx.db.patch(slotId, { state: "booked", bookingId });
    }
    await ctx.db.patch(hold._id, { status: "converted" });
    await ctx.db.patch(quote._id, { status: "accepted" });

    await recordAudit(ctx, {
      traceId: hold.traceId,
      actor: "system",
      type: "booking.confirmed",
      subjectId: bookingId,
      reason: `Booked ${hold.slotIds.length} slot(s) on net15 terms for ${advertiser.displayName}; no payment taken`,
      data: { holdId: hold._id, quoteId: quote._id, slotIds: hold.slotIds, invoiceId },
    });
    await recordAudit(ctx, {
      traceId: hold.traceId,
      actor: "system",
      type: "invoice.issued",
      subjectId: invoiceId,
      reason: `${number} for ${usd(hold.amountMinor)} issued to ${advertiser.displayName}, due ${new Date(dueAt).toISOString().slice(0, 10)}`,
      data: { number, amountMinor: hold.amountMinor, dueAt, bookingId },
    });

    if (campaign.creativeStatus === "approved") {
      const booking = await ctx.db.get(bookingId);
      if (booking) await scheduleBooking(ctx, booking, now, "system");
    }
    const booking = (await ctx.db.get(bookingId))!;
    return {
      bookingId,
      bookingStatus: booking.status,
      invoiceId,
      invoiceNumber: number,
      amountMinor: hold.amountMinor,
      issuedAt: now,
      dueAt,
      replayed: false,
    };
  },
});
