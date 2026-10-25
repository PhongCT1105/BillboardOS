import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { keyStatus } from "./lib/agentKeys";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from "./lib/webhook";

/**
 * Signed webhooks for rounds: `round_offer` (the host's offer for the next
 * 30-second window), `round_counter` (the host's one counter to this company),
 * `round_won` (highest agreed price: pay this hold over x402), `round_lost`. Same signing as every
 * other BillboardOS webhook: HMAC-SHA256 over "<timestamp>.<raw body>" with
 * the agent key's webhook secret. Rounds close in seconds: 5 s timeout, one
 * quick retry.
 */

export const roundEvent = v.union(v.literal("round_offer"), v.literal("round_counter"), v.literal("round_won"), v.literal("round_lost"));
const TIMEOUT_MS = 5_000;

function siteUrl(): string {
  return (process.env.CONVEX_SITE_URL ?? "https://billboardos.invalid").replace(/\/$/, "");
}

export const loadForDelivery = internalQuery({
  args: { bidId: v.id("roundBids"), event: roundEvent },
  returns: v.union(v.object({ ok: v.literal(true), url: v.string(), secret: v.string(), payload: v.any() }), v.object({ ok: v.literal(false), reason: v.string() })),
  handler: async (ctx, args) => {
    const bid = await ctx.db.get(args.bidId);
    const round = bid ? await ctx.db.get(bid.roundId) : null;
    if (!bid || !round) return { ok: false as const, reason: "round missing" };
    if ((args.event === "round_offer" || args.event === "round_counter") && (round.status !== "bidding" || bid.status !== "invited")) {
      return { ok: false as const, reason: "round already closed" };
    }
    const key = await ctx.db.get(bid.agentKeyId);
    if (!key?.webhookUrl || keyStatus(key, Date.now()) !== "active") return { ok: false as const, reason: "agent key inactive or without webhook" };
    const billboard = await ctx.db.get(round.billboardId);
    const recent = await ctx.db
      .query("priceWindows")
      .withIndex("by_billboard_and_at", (q) => q.eq("billboardId", round.billboardId).lt("at", round.spotStartAt))
      .order("desc")
      .take(5);
    const base = siteUrl();
    const common = { roundId: round._id, advertiserId: bid.advertiserId, campaignId: bid.campaignId };
    let payload: Record<string, unknown>;
    if (args.event === "round_offer" || args.event === "round_counter") {
      payload = {
        type: args.event,
        ...common,
        screen: { billboardId: round.billboardId, name: billboard?.name ?? "", locationLabel: billboard?.locationLabel ?? "" },
        spotEndAt: round.spotEndAt,
        floorMinor: round.floorMinor,
        askingMinor: round.askingMinor,
        /** The host's price to you now: accept it, or offer less (at or above floorMinor). */
        priceMinor: bid.offerMinor ?? round.askingMinor,
        yourLastOfferMinor: bid.amountMinor,
        /** The host already countered once: this is your final answer (any amount at or above the floor is agreed). */
        finalCounter: bid.countered === true,
        /** How your price was built: a x predicted + b x people + c x your brand value, clamped to [floor, cap]. */
        priceTerms: bid.priceTerms ?? null,
        audience: { summary: billboard?.audienceSummary ?? null, tags: billboard?.audienceTags ?? null, peopleInView: round.crowd, yourBuyersShare: bid.match },
        recentWinningPricesMinor: recent.filter((w) => w.winnerMinor !== null).map((w) => w.winnerMinor),
        /** The 30-second window you're buying, and when bidding for it ends (highest agreed price wins). */
        window: { startsAt: round.spotStartAt, endsAt: round.spotEndAt },
        closesAt: round.closesAt,
        standingInstructions: key.standing ?? null,
        links: { base, bid: `/api/agent/rounds/${round._id}/bid` },
        bidFormat: {
          amountMinor: "priceMinor or more agrees at priceMinor; less (at or above floorMinor) counters; null passes. The highest agreed price wins when bidding closes.",
          reasoning: "one sentence (optional)",
        },
      };
    } else if (args.event === "round_won") {
      const hold = round.holdId ? await ctx.db.get(round.holdId) : null;
      if (!hold || round.winnerBidId !== bid._id) return { ok: false as const, reason: "no hold for this bid" };
      payload = {
        type: "round_won",
        ...common,
        holdId: hold._id,
        amountMinor: hold.amountMinor,
        payBy: Math.min(hold.expiresAt, Date.now() + 60_000),
        purchaseUrl: `${base}/a2a/hosts/${round.workspaceId}/purchases/${hold._id}`,
        notes: "POST purchaseUrl with Authorization: Bearer <agent key with pay scope>; expect HTTP 402, then pay over x402.",
      };
    } else {
      payload = { type: "round_lost", ...common, yourAmountMinor: bid.amountMinor, outcome: round.outcome ?? null };
    }
    return { ok: true as const, url: key.webhookUrl, secret: key.webhookSecret, payload };
  },
});

export const deliver = internalAction({
  args: { bidId: v.id("roundBids"), event: roundEvent },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.roundDelivery.loadForDelivery, args);
    if (!job.ok) return null;
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
    console.warn(`round webhook ${args.event} for bid ${args.bidId} failed: ${lastError}`);
    return null;
  },
});
