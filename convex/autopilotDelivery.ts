import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { keyStatus } from "./lib/agentKeys";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from "./lib/webhook";

/**
 * Signed webhooks for the host autopilot's forward offers (ADR 0007 §1), the
 * same mechanism as live-auction announcements (momentDelivery.ts): HMAC-SHA256
 * over "<X-BillboardOS-Timestamp>.<raw body>" with the agent key's webhook
 * secret, POSTed to the key's webhook URL. A company agent run by our server
 * receives it at /company-agents/{advertiserId}/webhook (companyAgents.enqueue).
 *
 * Events:
 *   forward_offer   a slot offered ahead at a price (accept: autopilot.acceptForwardOffer
 *                   or POST /api/autopilot/offers/{offerId}/accept)
 *   forward_won     the company got the slot after a first look: pay the hold over x402
 *   forward_auction two or more companies wanted it: bid in the scheduled auction
 */

export const forwardEvent = v.union(v.literal("forward_offer"), v.literal("forward_won"), v.literal("forward_auction"));
const TIMEOUT_MS = 5_000;

function siteUrl(): string {
  return (process.env.CONVEX_SITE_URL ?? "https://billboardos.invalid").replace(/\/$/, "");
}

export const loadForDelivery = internalQuery({
  args: { offerId: v.id("forwardOffers"), advertiserId: v.id("advertisers"), event: forwardEvent },
  returns: v.union(v.object({ ok: v.literal(true), url: v.string(), secret: v.string(), payload: v.any() }), v.object({ ok: v.literal(false), reason: v.string() })),
  handler: async (ctx, args) => {
    const offer = await ctx.db.get(args.offerId);
    if (!offer) return { ok: false as const, reason: "offer missing" };
    if (args.event === "forward_offer" && offer.status !== "open") return { ok: false as const, reason: `offer is ${offer.status}` };
    const target = offer.targets.find((t) => t.advertiserId === args.advertiserId);
    const interest = (offer.interest ?? []).find((i) => i.advertiserId === args.advertiserId);
    const keyId = interest?.agentKeyId ?? target?.agentKeyId;
    const key = keyId ? await ctx.db.get(keyId) : null;
    if (!key || !key.webhookUrl || keyStatus(key, Date.now()) !== "active") return { ok: false as const, reason: "agent key inactive or without webhook" };
    const billboard = await ctx.db.get(offer.billboardId);
    const workspace = await ctx.db.get(offer.workspaceId);
    const slot = await ctx.db.get(offer.slotIds[0]);
    const base = siteUrl();
    const common = {
      offerId: offer._id,
      advertiserId: args.advertiserId,
      campaignId: interest?.campaignId ?? target?.campaignId ?? null,
      host: { workspaceId: offer.workspaceId, name: workspace?.name ?? "" },
      billboard: { billboardId: offer.billboardId, name: billboard?.name ?? "", city: billboard?.city ?? "", locationLabel: billboard?.locationLabel ?? "" },
      slot: {
        slotIds: offer.slotIds,
        startAt: offer.slotStartAt,
        endAt: slot?.endAt ?? offer.slotStartAt + 15 * 60_000,
        minutes: Math.round(((slot?.endAt ?? offer.slotStartAt + 15 * 60_000) - offer.slotStartAt) / 60_000),
      },
    };
    let payload: Record<string, unknown>;
    if (args.event === "forward_offer") {
      payload = {
        type: "forward_offer",
        ...common,
        band: offer.band,
        priceMinor: offer.priceMinor,
        floorMinor: offer.floorMinor,
        valueMinor: offer.valueMinor,
        forecast: offer.forecast,
        relevantViewers: target?.relevantViewers ?? null,
        audienceMatch: target?.matchScore ?? null,
        expiresAt: offer.expiresAt,
        firstLookUntil: offer.firstLookUntil ?? null,
        standingInstructions: key.standing ?? null,
        links: { base, accept: `/api/autopilot/offers/${offer._id}/accept` },
        acceptFormat: { campaignId: "optional (defaults to the campaign this offer was matched to)" },
      };
    } else if (args.event === "forward_won") {
      const holdId = offer.acceptedBy?.advertiserId === args.advertiserId ? offer.acceptedBy.holdId : null;
      const hold = holdId ? await ctx.db.get(holdId) : null;
      if (!hold) return { ok: false as const, reason: "no hold for this company" };
      payload = {
        type: "forward_won",
        ...common,
        holdId: hold._id,
        amountMinor: hold.amountMinor,
        payBy: hold.expiresAt,
        purchaseUrl: `${base}/a2a/hosts/${offer.workspaceId}/purchases/${hold._id}`,
        notes: "POST purchaseUrl with Authorization: Bearer <agent key with pay scope>; expect HTTP 402, then pay over x402.",
      };
    } else {
      const auction = offer.auctionId ? await ctx.db.get(offer.auctionId) : null;
      if (!auction) return { ok: false as const, reason: "no auction" };
      payload = {
        type: "forward_auction",
        ...common,
        auctionId: auction._id,
        reserveMinor: auction.reserveMinor,
        endsAt: auction.endsAt,
        links: {
          join: `/api/agent/auctions/${auction._id}/join`,
          bid: `/api/agent/auctions/${auction._id}/bid`,
          autoBid: `/api/agent/auctions/${auction._id}/auto-bid`,
        },
      };
    }
    return { ok: true as const, url: key.webhookUrl, secret: key.webhookSecret, payload };
  },
});

export const recordFailure = internalMutation({
  args: { offerId: v.id("forwardOffers"), advertiserId: v.id("advertisers"), event: forwardEvent, error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const offer = await ctx.db.get(args.offerId);
    if (!offer) return null;
    const company = (await ctx.db.get(args.advertiserId))?.displayName ?? "a company";
    await ctx.db.insert("autopilotLog", {
      workspaceId: offer.workspaceId,
      billboardId: offer.billboardId,
      slotId: offer.slotIds[0],
      offerId: offer._id,
      kind: "plan",
      text: `Couldn't reach ${company}'s agent with ${args.event.replace("_", " ")}: ${args.error.slice(0, 200)}`,
      at: Date.now(),
    });
    return null;
  },
});

export const deliver = internalAction({
  args: { offerId: v.id("forwardOffers"), advertiserId: v.id("advertisers"), event: forwardEvent },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.autopilotDelivery.loadForDelivery, args);
    if (!job.ok) {
      // A closed offer or an agent without a webhook is not a failure worth logging.
      if (!/^offer is /.test(job.reason)) await ctx.runMutation(internal.autopilotDelivery.recordFailure, { ...args, error: job.reason });
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
        if (res.ok) return null;
        lastError = `HTTP ${res.status}`;
      } catch (error) {
        lastError = controller.signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
      if (attempt === 1) await new Promise((r) => setTimeout(r, 750));
    }
    await ctx.runMutation(internal.autopilotDelivery.recordFailure, { ...args, error: lastError });
    return null;
  },
});
