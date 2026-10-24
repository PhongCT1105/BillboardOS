import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { signWebhook } from "./lib/webhook";
import { resolveWorkspace } from "./lib/tenancy";

/**
 * Hosted demo customer agents (ADR 0006), labeled "simulated customer agent"
 * everywhere. They are ours, but behave like external agents: they receive
 * real signed webhooks at /demo-agents/{advertiserId}/webhook, reply over the
 * real agent API with their own key, and pay over the real Convex x402 route.
 * Their plaintext agent keys are stored AES-GCM encrypted and never returned
 * by any query.
 */

const MAX_SKEW_MS = 5 * 60_000;

/** Constant-time comparison of two hex signatures. */
function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a webhook like an external receiver would: HMAC over
 * "<timestamp>.<raw body>" with the agent key's webhook secret, and a fresh
 * timestamp. Returns the demo agent's advertiser on success.
 */
export const verifyWebhook = internalQuery({
  args: { advertiserId: v.string(), timestamp: v.string(), signature: v.string(), body: v.string() },
  returns: v.union(v.object({ ok: v.literal(true), advertiserId: v.id("advertisers") }), v.object({ ok: v.literal(false), reason: v.string() })),
  handler: async (ctx, args) => {
    const advertiserId = ctx.db.normalizeId("advertisers", args.advertiserId);
    const demo = advertiserId
      ? await ctx.db
          .query("demoAgents")
          .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
          .first()
      : null;
    if (!demo) return { ok: false as const, reason: "unknown demo agent" };
    const key = await ctx.db.get(demo.agentKeyId);
    if (!key) return { ok: false as const, reason: "unknown demo agent" };
    const ts = Number(args.timestamp);
    if (!/^\d{1,16}$/.test(args.timestamp) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) return { ok: false as const, reason: "stale timestamp" };
    const expected = await signWebhook(key.webhookSecret, args.timestamp, args.body);
    if (!sameSignature(expected, args.signature)) return { ok: false as const, reason: "bad signature" };
    return { ok: true as const, advertiserId: demo.advertiserId };
  },
});

/** Accept a verified webhook and let the agent act on it asynchronously (the webhook returns at once). */
export const enqueue = internalMutation({
  args: { advertiserId: v.id("advertisers"), payload: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.demoAgentsNode.act, { advertiserId: args.advertiserId, payload: args.payload });
    return null;
  },
});

/** What the agent process needs to act (internal only; ciphertext, never the key). */
export const forAct = internalQuery({
  args: { advertiserId: v.id("advertisers") },
  returns: v.union(
    v.null(),
    v.object({ keyCiphertext: v.string(), keyIv: v.string(), walletName: v.string(), thinkMs: v.number(), slug: v.string(), company: v.string() }),
  ),
  handler: async (ctx, args) => {
    const demo = await ctx.db
      .query("demoAgents")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", args.advertiserId))
      .first();
    if (!demo) return null;
    const company = (await ctx.db.get(demo.advertiserId))?.displayName ?? demo.slug;
    return { keyCiphertext: demo.keyCiphertext, keyIv: demo.keyIv, walletName: demo.walletName, thinkMs: demo.thinkMs, slug: demo.slug, company };
  },
});

export const logAction = internalMutation({
  args: { advertiserId: v.id("advertisers"), action: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const demo = await ctx.db
      .query("demoAgents")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", args.advertiserId))
      .first();
    if (demo) await ctx.db.patch(demo._id, { lastAction: args.action.slice(0, 300), lastActionAt: Date.now() });
    return null;
  },
});

export const listDemo = internalQuery({
  args: {},
  returns: v.array(v.object({ advertiserId: v.id("advertisers"), walletName: v.string(), slug: v.string() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("demoAgents").take(20);
    return rows.map((r) => ({ advertiserId: r.advertiserId as Id<"advertisers">, walletName: r.walletName, slug: r.slug }));
  },
});

/** Host view: the simulated customer agents and what they last did (no secrets). */
export const list = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(
    v.object({
      company: v.string(),
      label: v.string(),
      walletName: v.string(),
      lastAction: v.union(v.string(), v.null()),
      lastActionAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    await resolveWorkspace(ctx, args.workspaceId);
    const rows = await ctx.db.query("demoAgents").take(20);
    const out = [];
    for (const r of rows) {
      out.push({
        company: (await ctx.db.get(r.advertiserId))?.displayName ?? r.slug,
        label: "simulated customer agent",
        walletName: r.walletName,
        lastAction: r.lastAction ?? null,
        lastActionAt: r.lastActionAt ?? null,
      });
    }
    return out;
  },
});
