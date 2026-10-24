import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { agentScope } from "./schema";
import { recordAudit } from "./lib/audit";
import { requireCustomer } from "./lib/tenancy";
import {
  AGENT_SCOPES,
  committedMinor,
  generateAgentKey,
  keyStatus,
  validWebhookUrl,
  type AgentScope,
} from "./lib/agentKeys";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BUDGET_MINOR = 10_000_000; // $100k

/** Shape returned once, at creation. The key and webhook secret are never shown again. */
export const issuedKey = v.object({
  agentKeyId: v.id("agentKeys"),
  name: v.string(),
  key: v.string(),
  prefix: v.string(),
  webhookSecret: v.string(),
  scopes: v.array(agentScope),
  budgetCapMinor: v.number(),
  expiresAt: v.number(),
});

/** Validate and store a new key for a company; returns the plaintext once. */
export async function issueAgentKey(
  ctx: MutationCtx,
  input: {
    advertiserId: Id<"advertisers">;
    name: string;
    scopes: AgentScope[];
    campaignIds?: Id<"campaigns">[];
    budgetCapMinor: number;
    expiresInDays: number;
    webhookUrl?: string;
    createdBy: string;
  },
) {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 60 || /[/\s]{2,}/.test(name)) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Key name must be 1..60 characters" });
  }
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || scopes.some((s) => !AGENT_SCOPES.includes(s))) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Choose at least one scope: quote, hold, bid, pay" });
  }
  if (!Number.isSafeInteger(input.budgetCapMinor) || input.budgetCapMinor <= 0 || input.budgetCapMinor > MAX_BUDGET_MINOR) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "budgetCapMinor must be an integer in (0, 10000000] (US cents)" });
  }
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 365) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "expiresInDays must be 1..365" });
  }
  const webhookUrl = input.webhookUrl?.trim() || undefined;
  if (webhookUrl !== undefined && (webhookUrl.length > 500 || !validWebhookUrl(webhookUrl))) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Webhook URL must be https (or http://localhost for development)" });
  }
  if (input.campaignIds) {
    if (input.campaignIds.length === 0 || input.campaignIds.length > 50) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Give 1..50 campaigns, or none for all of them" });
    }
    for (const id of input.campaignIds) {
      const c = await ctx.db.get(id);
      if (!c || c.advertiserId !== input.advertiserId) {
        throw new ConvexError({ code: "NOT_COMPANY_MEMBER", message: "Every allowed campaign must belong to your company" });
      }
    }
  }
  const generated = await generateAgentKey();
  const expiresAt = Date.now() + input.expiresInDays * DAY_MS;
  const agentKeyId = await ctx.db.insert("agentKeys", {
    advertiserId: input.advertiserId,
    name,
    prefix: generated.prefix,
    keyHash: generated.keyHash,
    scopes,
    campaignIds: input.campaignIds,
    budgetCapMinor: input.budgetCapMinor,
    expiresAt,
    webhookUrl,
    webhookSecret: generated.webhookSecret,
    createdBy: input.createdBy,
  });
  await recordAudit(ctx, {
    traceId: `company:${input.advertiserId}`,
    actor: input.createdBy,
    type: "agent_key.created",
    subjectId: agentKeyId,
    reason: `Agent key "${name}" (${generated.prefix}) issued: scopes ${scopes.join(", ")}, cap $${(input.budgetCapMinor / 100).toFixed(2)}`,
  });
  return {
    agentKeyId,
    name,
    key: generated.key,
    prefix: generated.prefix,
    webhookSecret: generated.webhookSecret,
    scopes,
    budgetCapMinor: input.budgetCapMinor,
    expiresAt,
  };
}

/** Customer issues a key for their own buying agent. The plaintext key is returned once. */
export const create = mutation({
  args: {
    advertiserId: v.optional(v.id("advertisers")),
    name: v.string(),
    scopes: v.array(agentScope),
    campaignIds: v.optional(v.array(v.id("campaigns"))),
    budgetCapMinor: v.number(),
    expiresInDays: v.optional(v.number()),
    webhookUrl: v.optional(v.string()),
  },
  returns: issuedKey,
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx, args.advertiserId);
    return await issueAgentKey(ctx, {
      advertiserId: customer.advertiserId,
      name: args.name,
      scopes: args.scopes,
      campaignIds: args.campaignIds,
      budgetCapMinor: args.budgetCapMinor,
      expiresInDays: args.expiresInDays ?? 30,
      webhookUrl: args.webhookUrl,
      createdBy: customer.actor,
    });
  },
});

/** The company's keys (no secrets), with what each has committed so far. */
export const list = query({
  args: { advertiserId: v.optional(v.id("advertisers")) },
  returns: v.array(
    v.object({
      agentKeyId: v.id("agentKeys"),
      name: v.string(),
      prefix: v.string(),
      scopes: v.array(agentScope),
      campaignIds: v.union(v.array(v.id("campaigns")), v.null()),
      budgetCapMinor: v.number(),
      committedMinor: v.number(),
      expiresAt: v.number(),
      revokedAt: v.union(v.number(), v.null()),
      webhookUrl: v.union(v.string(), v.null()),
      lastUsedAt: v.union(v.number(), v.null()),
      status: v.union(v.literal("active"), v.literal("revoked"), v.literal("expired")),
    }),
  ),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx, args.advertiserId);
    const now = Date.now();
    const keys = await ctx.db
      .query("agentKeys")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(50);
    const out = [];
    for (const k of keys) {
      out.push({
        agentKeyId: k._id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        campaignIds: k.campaignIds ?? null,
        budgetCapMinor: k.budgetCapMinor,
        committedMinor: await committedMinor(ctx, k._id),
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt ?? null,
        webhookUrl: k.webhookUrl ?? null,
        lastUsedAt: k.lastUsedAt ?? null,
        status: keyStatus(k, now),
      });
    }
    return out;
  },
});

/** Revoke a key immediately (idempotent). */
export const revoke = mutation({
  args: { agentKeyId: v.id("agentKeys") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.agentKeyId);
    if (!key) throw new ConvexError({ code: "NOT_FOUND", message: "Agent key not found" });
    const customer = await requireCustomer(ctx, key.advertiserId);
    if (key.revokedAt !== undefined) return null;
    await ctx.db.patch(key._id, { revokedAt: Date.now() });
    await recordAudit(ctx, {
      traceId: `company:${key.advertiserId}`,
      actor: customer.actor,
      type: "agent_key.revoked",
      subjectId: key._id,
      reason: `Agent key "${key.name}" (${key.prefix}) revoked`,
    });
    return null;
  },
});
