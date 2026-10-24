import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { currency, pricingConfidence, slotPriceBreakdown } from "./schema";
import { recordAudit } from "./lib/audit";
import { MAX_KEY_LENGTH, MAX_SLOTS_PER_QUOTE, QUOTE_TTL_MS } from "./lib/constants";
import { PRICING_POLICY_VERSION } from "./lib/pricing";
import { CONTENTION_MIN_BUYERS, CONTENTION_WINDOW_MS } from "./lib/auction";
import { computeScreenPrice } from "./lib/screenPrice";
import { applyCompanyMultiplier, heuristicAssessment } from "./lib/valuation";
import { currentAssessment, gatherCompanyInputs, requestAssessment } from "./valuation";
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
    /** Screen-price stages per slot (crowd, time, event, scarcity, market). */
    priceBreakdown: v.array(slotPriceBreakdown),
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
    // Hot slots under auction can't be bought at a posted price.
    for (const s of slots) {
      if (!s.auctionId) continue;
      const auction = await ctx.db.get(s.auctionId);
      if (auction?.status === "open") {
        throw new ConvexError({
          code: "AUCTION_OPEN",
          message: "This slot is being auctioned; join the auction to bid",
          auctionId: auction._id,
          slotId: s._id,
        });
      }
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

    // Screen price: crowd (trailing 15 min), time, event, scarcity, market.
    const { price, audienceAggregateId } = await computeScreenPrice(ctx.db, billboard, slots, now, {
      excludeCampaignId: args.campaignId,
    });
    const screenBreakdown = price.slotPrices.map((p, i) => ({
      slotId: slots[i]._id,
      slotStartAt: p.slotStartAt,
      computedMinor: p.computedMinor,
      screenMinor: p.amountMinor,
      floorApplied: p.floorApplied,
      ceilingApplied: p.ceilingApplied,
      stages: p.stages,
    }));
    const priceBreakdown = screenBreakdown;

    // Company valuation (posted quotes only; hidden from the buyer). Never
    // blocks: use the latest assessment, or an inline heuristic, and schedule
    // a refresh when stale.
    const valuation = await currentAssessment(ctx.db, campaign.advertiserId, now);
    let companyMultiplier = 1;
    let companyMethod: "claude" | "heuristic" | "override" | "inline_heuristic" = "inline_heuristic";
    if (valuation.assessment) {
      companyMultiplier = valuation.assessment.multiplier;
      companyMethod = valuation.assessment.method;
    } else {
      companyMultiplier = heuristicAssessment(await gatherCompanyInputs(ctx.db, campaign.advertiserId)).multiplier;
    }
    if (!valuation.fresh) {
      await requestAssessment(ctx, campaign.advertiserId, "quote requested without a fresh assessment");
    }
    const finalAmountMinor = screenBreakdown.reduce(
      (sum, b) => sum + applyCompanyMultiplier(b.screenMinor, companyMultiplier, billboard.reserveFloorMinor, price.ceilingMinor),
      0,
    );
    const pricingBasis =
      finalAmountMinor === price.amountMinor
        ? price.pricingBasis
        : [...price.pricingBasis, `Price for your account: $${(finalAmountMinor / 100).toFixed(2)}`];

    const expiresAt = now + QUOTE_TTL_MS;
    const traceId = `trace_${crypto.randomUUID()}`;
    const quoteId: Id<"quotes"> = await ctx.db.insert("quotes", {
      campaignId: args.campaignId,
      billboardId,
      slotIds: args.slotIds,
      amountMinor: finalAmountMinor,
      currency: "USD",
      expiresAt,
      pricingBasis,
      confidence: price.confidence,
      audienceAggregateId,
      policyVersion: PRICING_POLICY_VERSION,
      status: "open",
      traceId,
      priceBreakdown,
      screenAmountMinor: price.amountMinor,
      companyMultiplier,
      companyAssessmentId: valuation.assessment?._id,
      companyMethod,
    });

    await ctx.scheduler.runAt(expiresAt, internal.quotes.expire, { quoteId });

    // Seller agent hand-off: a second distinct buyer quoting the same slot
    // within 10 minutes makes it hot; check (and maybe auction) right away.
    const recent = await ctx.db
      .query("quotes")
      .withIndex("by_billboard_and_expiresAt", (q) => q.eq("billboardId", billboardId).gt("expiresAt", now))
      .take(100);
    for (const slotId of args.slotIds) {
      const buyers = new Set(
        recent
          .filter((q) => q.status === "open" && q._creationTime >= now - CONTENTION_WINDOW_MS && q.slotIds.includes(slotId))
          .map((q) => q.campaignId),
      );
      if (buyers.size >= CONTENTION_MIN_BUYERS) {
        await ctx.scheduler.runAfter(0, internal.auctions.openIfHot, { slotId });
      }
    }

    await recordAudit(ctx, {
      traceId,
      actor,
      type: "quote.created",
      subjectId: quoteId,
      reason: `Quoted ${args.slotIds.length} slot(s) at ${finalAmountMinor} USD minor units (screen ${price.amountMinor}, company x${companyMultiplier.toFixed(2)} ${companyMethod}; ${price.confidence} confidence)`,
      data: {
        campaignId: args.campaignId,
        billboardId,
        slotIds: args.slotIds,
        amountMinor: finalAmountMinor,
        screenAmountMinor: price.amountMinor,
        companyMultiplier,
        companyMethod,
        confidence: price.confidence,
        policyVersion: PRICING_POLICY_VERSION,
        expiresAt,
      },
    });

    return {
      quoteId,
      billboardId,
      slotIds: args.slotIds,
      amountMinor: finalAmountMinor,
      currency: "USD" as const,
      expiresAt,
      pricingBasis,
      confidence: price.confidence,
      policyVersion: PRICING_POLICY_VERSION,
      traceId,
      priceBreakdown,
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

const ESTIMATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ESTIMATE_SLOTS = 96;

/**
 * Screen-price estimates for a billboard's open slots starting in [from, to],
 * before any company valuation (only a real quote applies that). Read-only;
 * the caller passes `now` (the booking page floors it to the minute).
 */
export const estimates = query({
  args: {
    billboardId: v.id("billboards"),
    from: v.number(),
    to: v.number(),
    now: v.number(),
    /** The asking campaign: its own open quotes don't count as competing interest. */
    campaignId: v.optional(v.id("campaigns")),
  },
  returns: v.array(v.object({ slotId: v.id("slots"), amountMinor: v.number() })),
  handler: async (ctx, args) => {
    if (
      ![args.from, args.to, args.now].every(Number.isFinite) ||
      args.to < args.from ||
      args.to - args.from > ESTIMATE_WINDOW_MS
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Require finite from <= to within 24 hours, and a finite now",
      });
    }
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) return [];
    const slots = await ctx.db
      .query("slots")
      .withIndex("by_billboard_and_startAt", (q) =>
        q.eq("billboardId", args.billboardId).gte("startAt", args.from).lte("startAt", args.to),
      )
      .take(MAX_ESTIMATE_SLOTS);
    const open = slots.filter((s) => s.state === "available" && s.startAt > args.now);
    if (open.length === 0) return [];
    const { price } = await computeScreenPrice(ctx.db, billboard, open, args.now, {
      excludeCampaignId: args.campaignId,
    });
    return price.slotPrices.map((p, i) => ({ slotId: open[i]._id, amountMinor: p.amountMinor }));
  },
});
