import { v } from "convex/values";
import { env, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { keyStatus } from "./lib/agentKeys";
import {
  MAX_DELIVERY_ATTEMPTS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WEBHOOK_TIMEOUT_MS,
  nextRetryDelay,
  signWebhook,
} from "./lib/webhook";

/**
 * Agent delivery of watch alerts (ADR 0004): POST a signed JSON payload to the
 * agent key's webhook URL, 10 s timeout, 3 attempts with backoff, status
 * recorded on the alert. The secret never leaves the server except as the
 * HMAC signature.
 */

export const webhookSlot = v.object({
  slotId: v.id("slots"),
  startAt: v.number(),
  endAt: v.number(),
  screenPriceMinor: v.number(),
});

export const webhookPayload = v.object({
  alertId: v.id("alerts"),
  trigger: v.string(),
  campaignId: v.id("campaigns"),
  billboard: v.object({
    billboardId: v.id("billboards"),
    name: v.string(),
    city: v.string(),
    locationLabel: v.string(),
  }),
  slots: v.array(webhookSlot),
  matchCount: v.number(),
  auctionId: v.optional(v.id("auctions")),
  reason: v.string(),
  createdAt: v.number(),
  links: v.object({
    base: v.string(),
    quote: v.string(),
    hold: v.string(),
    alerts: v.string(),
    ack: v.string(),
    auction: v.optional(v.string()),
  }),
});

/** The JSON both the webhook and GET /api/agent/alerts return for one alert. */
export function alertPayload(alert: Doc<"alerts">, billboard: Doc<"billboards"> | null, base: string) {
  return {
    alertId: alert._id,
    trigger: alert.trigger,
    campaignId: alert.campaignId,
    billboard: {
      billboardId: alert.billboardId,
      name: billboard?.name ?? "Unknown screen",
      city: billboard?.city ?? "",
      locationLabel: billboard?.locationLabel ?? "",
    },
    slots: alert.slots,
    matchCount: alert.matchCount,
    ...(alert.auctionId ? { auctionId: alert.auctionId } : {}),
    reason: alert.reason,
    createdAt: alert.createdAt,
    links: {
      base,
      quote: "/api/agent/quotes",
      hold: "/api/agent/holds",
      alerts: "/api/agent/alerts",
      ack: `/api/agent/alerts/${alert._id}/ack`,
      ...(alert.auctionId ? { auction: `/api/agent/auctions/${alert.auctionId}/status` } : {}),
    },
  };
}

/** Everything one delivery attempt needs, or why it can't be attempted. */
export const loadForDelivery = internalQuery({
  args: { alertId: v.id("alerts") },
  returns: v.union(
    v.object({ ok: v.literal(true), url: v.string(), secret: v.string(), payload: webhookPayload, attempts: v.number() }),
    v.object({ ok: v.literal(false), reason: v.string() }),
  ),
  handler: async (ctx, args) => {
    const alert = await ctx.db.get(args.alertId);
    if (!alert || !alert.agent) return { ok: false as const, reason: "Alert has no agent delivery" };
    if (alert.agent.status !== "pending") return { ok: false as const, reason: `Already ${alert.agent.status}` };
    const rule = await ctx.db.get(alert.ruleId);
    const key = rule?.agentKeyId ? await ctx.db.get(rule.agentKeyId) : null;
    if (!key || key.advertiserId !== alert.advertiserId) return { ok: false as const, reason: "Agent key not found" };
    const status = keyStatus(key, Date.now());
    if (status !== "active") return { ok: false as const, reason: `Agent key is ${status}` };
    if (!key.webhookUrl) return { ok: false as const, reason: "Agent key has no webhook URL" };
    const billboard = await ctx.db.get(alert.billboardId);
    return {
      ok: true as const,
      url: key.webhookUrl,
      secret: key.webhookSecret,
      payload: alertPayload(alert, billboard, env.CONVEX_SITE_URL ?? ""),
      attempts: alert.agent.attempts,
    };
  },
});

/** Record one attempt's outcome; schedules the retry (or gives up) atomically. */
export const recordAttempt = internalMutation({
  args: {
    alertId: v.id("alerts"),
    ok: v.boolean(),
    error: v.optional(v.string()),
    /** Unrecoverable without a retry (key revoked, no URL): fail now. */
    final: v.optional(v.boolean()),
  },
  returns: v.object({ status: v.string(), attempts: v.number(), retryInMs: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const alert = await ctx.db.get(args.alertId);
    if (!alert || !alert.agent) return { status: "missing", attempts: 0, retryInMs: null };
    if (alert.agent.status !== "pending") {
      return { status: alert.agent.status, attempts: alert.agent.attempts, retryInMs: null };
    }
    const now = Date.now();
    if (args.final) {
      await ctx.db.patch(alert._id, {
        agent: { ...alert.agent, status: "failed", lastError: args.error?.slice(0, 300), lastAttemptAt: now },
      });
      return { status: "failed", attempts: alert.agent.attempts, retryInMs: null };
    }
    const attempts = alert.agent.attempts + 1;
    if (args.ok) {
      await ctx.db.patch(alert._id, {
        agent: { status: "delivered", attempts, lastAttemptAt: now, deliveredAt: now },
      });
      return { status: "delivered", attempts, retryInMs: null };
    }
    const retryInMs = nextRetryDelay(attempts);
    await ctx.db.patch(alert._id, {
      agent: {
        status: retryInMs === null ? "failed" : "pending",
        attempts,
        lastAttemptAt: now,
        lastError: (args.error ?? "Delivery failed").slice(0, 300),
      },
    });
    if (retryInMs !== null) {
      await ctx.scheduler.runAfter(retryInMs, internal.watchDelivery.deliver, { alertId: alert._id });
    }
    return { status: retryInMs === null ? "failed" : "pending", attempts, retryInMs };
  },
});

/** One delivery attempt. Scheduled by the matcher; retries are scheduled by recordAttempt. */
export const deliver = internalAction({
  args: { alertId: v.id("alerts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.watchDelivery.loadForDelivery, { alertId: args.alertId });
    if (!job.ok) {
      if (!job.reason.startsWith("Already")) {
        await ctx.runMutation(internal.watchDelivery.recordAttempt, { alertId: args.alertId, ok: false, error: job.reason, final: true });
      }
      return null;
    }
    if (job.attempts >= MAX_DELIVERY_ATTEMPTS) return null;
    const body = JSON.stringify(job.payload);
    const signature = await signWebhook(job.secret, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    let ok = false;
    let error: string | undefined;
    try {
      const res = await fetch(job.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "BillboardOS-Webhooks/1",
          [SIGNATURE_HEADER]: signature,
          [TIMESTAMP_HEADER]: String(Date.now()),
        },
        body,
        signal: controller.signal,
      });
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = controller.signal.aborted ? `Timed out after ${WEBHOOK_TIMEOUT_MS / 1000}s` : e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    await ctx.runMutation(internal.watchDelivery.recordAttempt, { alertId: args.alertId, ok, error });
    return null;
  },
});

export type AlertPayload = ReturnType<typeof alertPayload>;
