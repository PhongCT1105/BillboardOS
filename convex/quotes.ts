import { ConvexError, v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { currency, pricingConfidence } from "./schema";
import { recordAudit } from "./lib/audit";
import { MAX_KEY_LENGTH, MAX_SLOTS_PER_QUOTE, QUOTE_TTL_MS } from "./lib/constants";
import {
  AUDIENCE_STALE_AFTER_MS,
  PRICING_POLICY_VERSION,
  priceQuote,
} from "./lib/pricing";
import { assertBoundedString } from "./lib/validators";

/**
 * Create a deterministic, expiring quote for a set of available slots on one
 * billboard. A quote is NOT a booking and does not reserve inventory; call
 * `holds.create` to take an exclusive hold.
 */
export const create = mutation({
  args: {
    campaignId: v.id("campaigns"),
    slotIds: v.array(v.id("slots")),
    /** Who is asking, for the audit log (e.g. "buyer", "agent:advertiser"). */
    actor: v.optional(v.string()),
  },
  returns: v.object({
    quoteId: v.id("quotes"),
    billboardId: v.id("billboards"),
    slotIds: v.array(v.id("slots")),
    amountMinor: v.number(),
    currency,
    expiresAt: v.number(),
    pricingBasis: v.array(v.string()),
    confidence: pricingConfidence,
    policyVersion: v.string(),
    traceId: v.string(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const actor = args.actor ?? "buyer";
    assertBoundedString("actor", actor, MAX_KEY_LENGTH);

    if (args.slotIds.length === 0 || args.slotIds.length > MAX_SLOTS_PER_QUOTE) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `A quote needs 1..${MAX_SLOTS_PER_QUOTE} slots`,
      });
    }
    if (new Set(args.slotIds).size !== args.slotIds.length) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Duplicate slot ids" });
    }

    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found" });
    }
    if (campaign.status === "completed" || campaign.status === "cancelled") {
      throw new ConvexError({
        code: "CAMPAIGN_CLOSED",
        message: `Campaign is ${campaign.status}`,
      });
    }

    const slots: Doc<"slots">[] = [];
    for (const slotId of args.slotIds) {
      const slot = await ctx.db.get(slotId);
      if (!slot) {
        throw new ConvexError({ code: "NOT_FOUND", message: `Slot ${slotId} not found` });
      }
      slots.push(slot);
    }

    const billboardId = slots[0].billboardId;
    if (slots.some((s) => s.billboardId !== billboardId)) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "All slots in a quote must be on the same billboard",
      });
    }
    const unavailable = slots.filter((s) => s.state !== "available" || s.startAt <= now);
    if (unavailable.length > 0) {
      throw new ConvexError({
        code: "SLOT_UNAVAILABLE",
        message: "One or more slots are not available",
        slotIds: unavailable.map((s) => s._id),
      });
    }

    const billboard = await ctx.db.get(billboardId);
    if (!billboard) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    }
    if (billboard.deviceStatus !== "online") {
      throw new ConvexError({
        code: "BILLBOARD_OFFLINE",
        message: "Billboard device is offline; not selling airtime",
      });
    }

    // Most recent non-stale audience bucket (bounded on both sides).
    const audience = await ctx.db
      .query("audienceAggregates")
      .withIndex("by_billboard_and_bucketStart", (q) =>
        q
          .eq("billboardId", billboardId)
          .gte("bucketStart", now - AUDIENCE_STALE_AFTER_MS)
          .lte("bucketStart", now),
      )
      .order("desc")
      .first();

    const price = priceQuote({
      baseRateMinor: billboard.baseRateMinor,
      reserveFloorMinor: billboard.reserveFloorMinor,
      utcOffsetMinutes: billboard.utcOffsetMinutes,
      slotStartTimes: slots.map((s) => s.startAt),
      audience: audience
        ? {
            countEstimate: audience.countEstimate,
            bucketStart: audience.bucketStart,
            source: audience.source,
            confidence: audience.confidence,
          }
        : null,
      now,
    });

    const expiresAt = now + QUOTE_TTL_MS;
    const traceId = `trace_${crypto.randomUUID()}`;
    const quoteId: Id<"quotes"> = await ctx.db.insert("quotes", {
      campaignId: args.campaignId,
      billboardId,
      slotIds: args.slotIds,
      amountMinor: price.amountMinor,
      currency: "USD",
      expiresAt,
      pricingBasis: price.pricingBasis,
      confidence: price.confidence,
      audienceAggregateId: audience?._id,
      policyVersion: PRICING_POLICY_VERSION,
      status: "open",
      traceId,
    });

    await ctx.scheduler.runAt(expiresAt, internal.quotes.expire, { quoteId });

    await recordAudit(ctx, {
      traceId,
      actor,
      type: "quote.created",
      subjectId: quoteId,
      reason: `Quoted ${args.slotIds.length} slot(s) at ${price.amountMinor} USD minor units (${price.confidence} confidence)`,
      data: {
        campaignId: args.campaignId,
        billboardId,
        slotIds: args.slotIds,
        amountMinor: price.amountMinor,
        confidence: price.confidence,
        policyVersion: PRICING_POLICY_VERSION,
        expiresAt,
      },
    });

    return {
      quoteId,
      billboardId,
      slotIds: args.slotIds,
      amountMinor: price.amountMinor,
      currency: "USD" as const,
      expiresAt,
      pricingBasis: price.pricingBasis,
      confidence: price.confidence,
      policyVersion: PRICING_POLICY_VERSION,
      traceId,
    };
  },
});

/**
 * Scheduled at quote expiry. No-op unless the quote is still open and has no
 * active hold (an active hold's own expiry/payment governs the quote then).
 */
export const expire = internalMutation({
  args: { quoteId: v.id("quotes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.status !== "open") return null;
    if (Date.now() < quote.expiresAt) return null;

    const activeHold = await ctx.db
      .query("holds")
      .withIndex("by_quote_and_status", (q) =>
        q.eq("quoteId", args.quoteId).eq("status", "active"),
      )
      .first();
    if (activeHold) return null;

    await ctx.db.patch(args.quoteId, { status: "expired" });
    await recordAudit(ctx, {
      traceId: quote.traceId,
      actor: "system",
      type: "quote.expired",
      subjectId: args.quoteId,
      reason: "Quote reached expiresAt without a booking",
    });
    return null;
  },
});
