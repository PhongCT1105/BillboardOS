import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { keyStatus } from "./lib/agentKeys";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from "./lib/webhook";
import { addMomentStep } from "./lib/momentHooks";
import { MAX_BIDS_PER_COMPANY, NEGOTIATION_MAX_ROUNDS, NEGOTIATION_TIME_CAP_MS, minNextLiveBid } from "./lib/liveAuction";
import { MAX_OFFERS } from "./lib/moment";

/**
 * Signed webhooks for live moments (ADR 0006): `flash_offer` (the
 * announcement), `auction_started`, `auction_update`, `negotiation_counter`,
 * `flash_won`, `flash_lost`. Same signing as watch alerts: HMAC-SHA256 over
 * "<X-BillboardOS-Timestamp>.<raw body>" with the agent key's webhook secret.
 * The response window is seconds long, so: 5 s timeout, one quick retry.
 */

const flashEvent = v.union(
  v.literal("flash_offer"),
  v.literal("auction_started"),
  v.literal("auction_update"),
  v.literal("negotiation_counter"),
  v.literal("flash_won"),
  v.literal("flash_lost"),
);
const TIMEOUT_MS = 5_000;

function siteUrl(): string {
  return (process.env.CONVEX_SITE_URL ?? "https://billboardos.invalid").replace(/\/$/, "");
}

export const loadForDelivery = internalQuery({
  args: { offerId: v.id("flashOffers"), event: flashEvent },
  returns: v.union(v.object({ ok: v.literal(true), url: v.string(), secret: v.string(), payload: v.any() }), v.object({ ok: v.literal(false), reason: v.string() })),
  handler: async (ctx, args) => {
    const offer = await ctx.db.get(args.offerId);
    if (!offer) return { ok: false as const, reason: "offer missing" };
    const key = await ctx.db.get(offer.agentKeyId);
    if (!key || !key.webhookUrl || keyStatus(key, Date.now()) !== "active") return { ok: false as const, reason: "agent key inactive or without webhook" };
    const moment = (await ctx.db.get(offer.momentId))!;
    const billboard = await ctx.db.get(moment.billboardId);
    const workspace = await ctx.db.get(moment.workspaceId);
    const base = siteUrl();
    const common = {
      offerId: offer._id,
      momentId: moment._id,
      advertiserId: offer.advertiserId,
      campaignId: offer.campaignId,
      host: { workspaceId: moment.workspaceId, name: workspace?.name ?? "" },
      billboard: { billboardId: moment.billboardId, name: billboard?.name ?? "", city: billboard?.city ?? "", locationLabel: billboard?.locationLabel ?? "" },
    };
    let payload: Record<string, unknown>;
    if (args.event === "flash_offer") {
      payload = {
        type: "flash_offer",
        ...common,
        spot: {
          slotId: moment.slotId,
          startAt: moment.spotStartAt,
          endAt: moment.spotEndAt,
          minutes: Math.round((moment.spotEndAt - moment.spotStartAt) / 60_000),
        },
        priceMinor: offer.priceMinor,
        valueMinor: moment.valueMinor ?? null,
        openingMinor: moment.priceMinor,
        minimumMinor: moment.floorMinor,
        why: moment.priceWhy ?? moment.reasoning,
        crowd: moment.crowd,
        relevantViewers: offer.relevantViewers,
        audienceMatch: offer.matchScore,
        event: moment.eventName ?? null,
        reasoning: moment.reasoning,
        respondBy: moment.offerClosesAt,
        standingInstructions: key.standing ?? null,
        links: { base, reply: `/api/agent/offers/${offer._id}/reply` },
        replyFormat: { decision: "accept | counter | pass", amountMinor: "required for counter (US cents)", reasoning: "optional" },
      };
    } else if (args.event === "auction_started" || args.event === "auction_update") {
      const leaderMinor = moment.leaderOfferId ? (moment.currentMinor ?? null) : null;
      const live = {
        minNextMinor: minNextLiveBid({ leaderMinor, openingMinor: moment.priceMinor }),
        closesAt: moment.biddingClosesAt ?? null,
        bidsLeft: Math.max(0, MAX_BIDS_PER_COMPANY - (offer.bidCount ?? 0)),
      };
      if (args.event === "auction_started") {
        const offers = await ctx.db
          .query("flashOffers")
          .withIndex("by_moment", (q) => q.eq("momentId", moment._id))
          .take(MAX_OFFERS + 1);
        payload = {
          type: "auction_started",
          ...common,
          openingMinor: moment.priceMinor,
          ...live,
          participants: offers.filter((o) => o.status === "accepted" || o.status === "countered").length,
          links: { bid: `/api/agent/offers/${offer._id}/bid` },
        };
      } else {
        // The leader placed the last bid.
        const youLead = moment.leaderOfferId === offer._id;
        payload = { type: "auction_update", ...common, currentMinor: moment.currentMinor ?? null, youLead, ...live, lastBidBy: youLead ? "you" : "another company" };
      }
    } else if (args.event === "negotiation_counter") {
      const round = moment.negotiationRound ?? 1;
      payload = {
        type: "negotiation_counter",
        ...common,
        sellerMinor: moment.sellerMinor ?? moment.priceMinor,
        round,
        roundsLeft: Math.max(0, NEGOTIATION_MAX_ROUNDS - round),
        respondBy: moment.startedAt + NEGOTIATION_TIME_CAP_MS,
        links: { reply: `/api/agent/offers/${offer._id}/reply` },
      };
    } else if (args.event === "flash_won") {
      const hold = offer.holdId ? await ctx.db.get(offer.holdId) : null;
      if (!hold) return { ok: false as const, reason: "no hold" };
      payload = {
        type: "flash_won",
        ...common,
        holdId: hold._id,
        amountMinor: hold.amountMinor,
        payBy: Math.min(hold.expiresAt, Date.now() + 60_000),
        purchaseUrl: `${base}/a2a/hosts/${moment.workspaceId}/purchases/${hold._id}`,
        notes: "POST purchaseUrl with Authorization: Bearer <agent key with pay scope>; expect HTTP 402, then pay over x402.",
      };
    } else {
      payload = { type: "flash_lost", ...common, yourAmountMinor: offer.replyAmountMinor ?? null };
    }
    return { ok: true as const, url: key.webhookUrl, secret: key.webhookSecret, payload };
  },
});

export const recordDelivery = internalMutation({
  args: { offerId: v.id("flashOffers"), event: flashEvent, ok: v.boolean(), attempts: v.number(), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const offer = await ctx.db.get(args.offerId);
    if (!offer) return null;
    const now = Date.now();
    if (args.event === "flash_offer") {
      await ctx.db.patch(offer._id, {
        delivery: {
          status: args.ok ? "delivered" : "failed",
          attempts: args.attempts,
          lastAttemptAt: now,
          deliveredAt: args.ok ? now : undefined,
          lastError: args.error?.slice(0, 300),
        },
      });
    }
    if (!args.ok || args.event === "flash_won") {
      const moment = await ctx.db.get(offer.momentId);
      const company = (await ctx.db.get(offer.advertiserId))?.displayName ?? "agent";
      if (moment) {
        await addMomentStep(
          ctx,
          moment,
          `webhook:${args.event}:${offer._id}`,
          args.ok ? `${args.event} webhook delivered to ${company}` : `${args.event} webhook to ${company} failed`,
          args.error,
          now,
        );
      }
    }
    return null;
  },
});

export const deliver = internalAction({
  args: { offerId: v.id("flashOffers"), event: flashEvent },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.momentDelivery.loadForDelivery, args);
    if (!job.ok) {
      await ctx.runMutation(internal.momentDelivery.recordDelivery, { ...args, ok: false, attempts: 0, error: job.reason });
      return null;
    }
    const body = JSON.stringify(job.payload);
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const timestamp = String(Date.now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(job.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "BillboardOS-Webhooks/1",
            "X-BillboardOS-Event": args.event,
            [SIGNATURE_HEADER]: await signWebhook(job.secret, timestamp, body),
            [TIMESTAMP_HEADER]: timestamp,
          },
          body,
          signal: controller.signal,
        });
        if (res.ok) {
          await ctx.runMutation(internal.momentDelivery.recordDelivery, { ...args, ok: true, attempts: attempt });
          return null;
        }
        lastError = `HTTP ${res.status}`;
      } catch (error) {
        lastError = controller.signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
      if (attempt === 1) await new Promise((r) => setTimeout(r, 750));
    }
    await ctx.runMutation(internal.momentDelivery.recordDelivery, { ...args, ok: false, attempts: 2, error: lastError });
    return null;
  },
});
