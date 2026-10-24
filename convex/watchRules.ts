import { ConvexError, v } from "convex/values";
import { mutation, query, internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { watchDelivery, watchTrigger } from "./schema";
import { recordAudit } from "./lib/audit";
import { requireCustomer, type CustomerMember } from "./lib/tenancy";
import { keyStatus } from "./lib/agentKeys";
import { summarizeRule } from "./lib/watch";

/**
 * Watch rules (ADR 0004): "tell me (or my agent) when a spot fits".
 * Customer-scoped CRUD. `delete` is a reserved word, so removal is `remove`.
 */

const MAX_RULES_PER_COMPANY = 50;
const MAX_PRICE_MINOR = 10_000_000;
const MAX_FIRST_RUN_BILLBOARDS = 50;
const MATCH_CLEANUP_BATCH = 500;

const ruleInput = {
  campaignId: v.id("campaigns"),
  name: v.optional(v.string()),
  cities: v.optional(v.array(v.string())),
  billboardIds: v.optional(v.array(v.id("billboards"))),
  minMatch: v.optional(v.number()),
  maxPriceMinor: v.number(),
  daysOfWeek: v.optional(v.array(v.number())),
  hourStart: v.optional(v.number()),
  hourEnd: v.optional(v.number()),
  dateFrom: v.optional(v.number()),
  dateTo: v.optional(v.number()),
  triggers: v.array(watchTrigger),
  delivery: v.array(watchDelivery),
  agentKeyId: v.optional(v.id("agentKeys")),
};

export type RuleInput = {
  campaignId: Id<"campaigns">;
  name?: string;
  cities?: string[];
  billboardIds?: Id<"billboards">[];
  minMatch?: number;
  maxPriceMinor: number;
  daysOfWeek?: number[];
  hourStart?: number;
  hourEnd?: number;
  dateFrom?: number;
  dateTo?: number;
  triggers: Doc<"watchRules">["triggers"];
  delivery: Doc<"watchRules">["delivery"];
  agentKeyId?: Id<"agentKeys">;
};

/** "Nvidia GTC promo: reach developers..." -> "Watch: Nvidia GTC promo" (first clause, word boundary). */
function defaultName(brief: string): string {
  const clause = brief.split(/[:.;,\n]/)[0].trim();
  const words = clause.split(/\s+/);
  let out = "";
  for (const w of words) {
    if ((out + " " + w).trim().length > 36) break;
    out = (out + " " + w).trim();
  }
  return `Watch: ${out || "campaign"}${out.length < clause.length ? "..." : ""}`;
}

function bad(message: string): never {
  throw new ConvexError({ code: "INVALID_INPUT", message });
}

/** Validate and normalize a rule for this company. Throws INVALID_INPUT / NOT_COMPANY_MEMBER. */
async function normalizeRule(ctx: MutationCtx, advertiserId: Id<"advertisers">, input: RuleInput) {
  const campaign = await ctx.db.get(input.campaignId);
  if (!campaign || campaign.advertiserId !== advertiserId) {
    throw new ConvexError({ code: "NOT_COMPANY_MEMBER", message: "That campaign belongs to another company" });
  }
  if (!Number.isSafeInteger(input.maxPriceMinor) || input.maxPriceMinor <= 0 || input.maxPriceMinor > MAX_PRICE_MINOR) {
    bad("maxPriceMinor must be a whole number of cents in (0, 10000000]");
  }
  const cities = input.cities?.map((c) => c.trim()).filter((c) => c.length > 0);
  if (cities && (cities.length > 10 || cities.some((c) => c.length > 60))) bad("Up to 10 cities, 60 characters each");
  const billboardIds = input.billboardIds && input.billboardIds.length > 0 ? [...new Set(input.billboardIds)] : undefined;
  if (billboardIds) {
    if (billboardIds.length > 20) bad("Up to 20 screens");
    for (const id of billboardIds) if (!(await ctx.db.get(id))) bad("Unknown screen");
  }
  if (input.minMatch !== undefined && (!Number.isFinite(input.minMatch) || input.minMatch < 0 || input.minMatch > 1)) {
    bad("minMatch must be between 0 and 1");
  }
  const days = input.daysOfWeek && input.daysOfWeek.length > 0 ? [...new Set(input.daysOfWeek)].sort() : undefined;
  if (days && days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) bad("daysOfWeek are 0 (Sun) .. 6 (Sat)");
  for (const [label, h] of [["hourStart", input.hourStart], ["hourEnd", input.hourEnd]] as const) {
    if (h !== undefined && (!Number.isFinite(h) || h < 0 || h > 24)) bad(`${label} must be 0..24 (local time)`);
  }
  if (input.hourStart !== undefined && input.hourEnd !== undefined && input.hourStart >= input.hourEnd) {
    bad("hourStart must be before hourEnd");
  }
  for (const [label, t] of [["dateFrom", input.dateFrom], ["dateTo", input.dateTo]] as const) {
    if (t !== undefined && !Number.isFinite(t)) bad(`${label} must be a timestamp`);
  }
  if (input.dateFrom !== undefined && input.dateTo !== undefined && input.dateFrom > input.dateTo) {
    bad("dateFrom must be before dateTo");
  }
  const triggers = [...new Set(input.triggers)];
  if (triggers.length === 0) bad("Pick at least one trigger");
  const delivery = [...new Set(input.delivery)];
  if (delivery.length === 0) bad("Pick inbox, agent, or both");
  let agentKeyId: Id<"agentKeys"> | undefined;
  if (delivery.includes("agent")) {
    if (!input.agentKeyId) bad("Agent delivery needs an agent key with a webhook URL");
    const key = await ctx.db.get(input.agentKeyId);
    if (!key || key.advertiserId !== advertiserId) {
      throw new ConvexError({ code: "NOT_COMPANY_MEMBER", message: "That agent key belongs to another company" });
    }
    if (keyStatus(key, Date.now()) !== "active") bad("That agent key is revoked or expired");
    if (!key.webhookUrl) bad("That agent key has no webhook URL; create one with a webhook");
    agentKeyId = key._id;
  }
  const name = (input.name?.trim() || defaultName(campaign.brief)).slice(0, 80);
  return {
    campaignId: campaign._id,
    name,
    cities: cities && cities.length > 0 ? cities : undefined,
    billboardIds,
    minMatch: input.minMatch && input.minMatch > 0 ? input.minMatch : undefined,
    maxPriceMinor: input.maxPriceMinor,
    daysOfWeek: days,
    hourStart: input.hourStart,
    hourEnd: input.hourEnd,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    triggers,
    delivery,
    agentKeyId,
  };
}

/** Run the matcher for one rule across its screens (first alerts arrive right away). */
async function scheduleFirstRun(ctx: MutationCtx, rule: Doc<"watchRules">): Promise<void> {
  const ids =
    rule.billboardIds ??
    (await ctx.db.query("billboards").take(MAX_FIRST_RUN_BILLBOARDS)).filter((b) => b.deviceStatus === "online").map((b) => b._id);
  for (const billboardId of ids) {
    await ctx.scheduler.runAfter(0, internal.watch.match, { billboardIds: [billboardId], ruleId: rule._id, reason: "rule saved" });
  }
}

async function audit(ctx: MutationCtx, customer: CustomerMember, ruleId: Id<"watchRules">, reason: string) {
  await recordAudit(ctx, {
    traceId: `company:${customer.advertiserId}`,
    actor: customer.actor,
    type: "watch_rule.changed",
    subjectId: ruleId,
    reason: reason.slice(0, 1000),
  });
}

async function ownRule(ctx: MutationCtx, ruleId: Id<"watchRules">) {
  const rule = await ctx.db.get(ruleId);
  if (!rule) throw new ConvexError({ code: "NOT_FOUND", message: "Watch rule not found" });
  const customer = await requireCustomer(ctx, rule.advertiserId);
  return { rule, customer };
}

/** Validate, insert, audit and run a new rule once. Shared by `create` and the demo seed. */
export async function insertRule(
  ctx: MutationCtx,
  advertiserId: Id<"advertisers">,
  input: RuleInput,
  actor: string,
): Promise<{ ruleId: Id<"watchRules">; summary: string }> {
  const fields = await normalizeRule(ctx, advertiserId, input);
  const ruleId = await ctx.db.insert("watchRules", { advertiserId, ...fields, active: true, createdBy: actor });
  const rule = (await ctx.db.get(ruleId))!;
  const summary = summarizeRule(rule);
  await recordAudit(ctx, {
    traceId: `company:${advertiserId}`,
    actor,
    type: "watch_rule.changed",
    subjectId: ruleId,
    reason: `Watch rule "${rule.name}" created: ${summary}`.slice(0, 1000),
  });
  await scheduleFirstRun(ctx, rule);
  return { ruleId, summary };
}

/** Create a watch rule for one of the company's campaigns. */
export const create = mutation({
  args: { advertiserId: v.optional(v.id("advertisers")), ...ruleInput },
  returns: v.object({ ruleId: v.id("watchRules"), summary: v.string() }),
  handler: async (ctx, { advertiserId, ...input }) => {
    const customer = await requireCustomer(ctx, advertiserId);
    const existing = await ctx.db
      .query("watchRules")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .take(MAX_RULES_PER_COMPANY);
    if (existing.length >= MAX_RULES_PER_COMPANY) bad(`A company can have up to ${MAX_RULES_PER_COMPANY} watch rules`);
    return await insertRule(ctx, customer.advertiserId, input, customer.actor);
  },
});

/** Replace a rule's settings (same shape as create). Re-runs the matcher. */
export const update = mutation({
  args: { ruleId: v.id("watchRules"), ...ruleInput },
  returns: v.object({ ruleId: v.id("watchRules"), summary: v.string() }),
  handler: async (ctx, { ruleId, ...input }) => {
    const { rule, customer } = await ownRule(ctx, ruleId);
    const fields = await normalizeRule(ctx, rule.advertiserId, input);
    await ctx.db.replace(rule._id, {
      advertiserId: rule.advertiserId,
      ...fields,
      active: rule.active,
      createdBy: rule.createdBy,
    });
    const updated = (await ctx.db.get(rule._id))!;
    const summary = summarizeRule(updated);
    await audit(ctx, customer, rule._id, `Watch rule "${updated.name}" updated: ${summary}`);
    if (updated.active) await scheduleFirstRun(ctx, updated);
    return { ruleId: rule._id, summary };
  },
});

/** Pause (default) or resume a rule. Paused rules never alert. */
export const pause = mutation({
  args: { ruleId: v.id("watchRules"), paused: v.optional(v.boolean()) },
  returns: v.object({ active: v.boolean() }),
  handler: async (ctx, args) => {
    const { rule, customer } = await ownRule(ctx, args.ruleId);
    const active = args.paused === false;
    if (rule.active === active) return { active };
    await ctx.db.patch(rule._id, { active });
    await audit(ctx, customer, rule._id, `Watch rule "${rule.name}" ${active ? "resumed" : "paused"}`);
    if (active) {
      if (rule.delivery.includes("agent") && rule.agentKeyId) {
        const key = await ctx.db.get(rule.agentKeyId);
        if (!key || keyStatus(key, Date.now()) !== "active") bad("Its agent key is revoked or expired; edit the rule first");
      }
      await scheduleFirstRun(ctx, rule);
    }
    return { active };
  },
});

/** Delete a rule (its past alerts stay in the inbox). */
export const remove = mutation({
  args: { ruleId: v.id("watchRules") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { rule, customer } = await ownRule(ctx, args.ruleId);
    await ctx.db.delete(rule._id);
    await audit(ctx, customer, rule._id, `Watch rule "${rule.name}" deleted`);
    await ctx.scheduler.runAfter(0, internal.watchRules.cleanupMatches, { ruleId: rule._id });
    return null;
  },
});

/** Drop dedupe memory for a deleted rule, in batches. */
export const cleanupMatches = internalMutation({
  args: { ruleId: v.id("watchRules") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("watchMatches")
      .withIndex("by_rule_and_slot", (q) => q.eq("ruleId", args.ruleId))
      .take(MATCH_CLEANUP_BATCH);
    for (const r of rows) await ctx.db.delete(r._id);
    if (rows.length === MATCH_CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.watchRules.cleanupMatches, { ruleId: args.ruleId });
    }
    return rows.length;
  },
});

export const ruleView = v.object({
  ruleId: v.id("watchRules"),
  name: v.string(),
  summary: v.string(),
  campaignId: v.id("campaigns"),
  campaignBrief: v.string(),
  cities: v.union(v.array(v.string()), v.null()),
  billboardIds: v.union(v.array(v.id("billboards")), v.null()),
  minMatch: v.union(v.number(), v.null()),
  maxPriceMinor: v.number(),
  daysOfWeek: v.union(v.array(v.number()), v.null()),
  hourStart: v.union(v.number(), v.null()),
  hourEnd: v.union(v.number(), v.null()),
  dateFrom: v.union(v.number(), v.null()),
  dateTo: v.union(v.number(), v.null()),
  triggers: v.array(watchTrigger),
  delivery: v.array(watchDelivery),
  agentKey: v.union(
    v.object({ agentKeyId: v.id("agentKeys"), name: v.string(), prefix: v.string(), status: v.string() }),
    v.null(),
  ),
  active: v.boolean(),
  createdAt: v.number(),
});

/** The company's rules, newest first, each with a plain-language summary. */
export const list = query({
  args: { advertiserId: v.optional(v.id("advertisers")) },
  returns: v.array(ruleView),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx, args.advertiserId);
    const rules = await ctx.db
      .query("watchRules")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(MAX_RULES_PER_COMPANY);
    const now = Date.now();
    const out = [];
    for (const r of rules) {
      const names: Record<string, string> = {};
      for (const id of r.billboardIds ?? []) {
        const b = await ctx.db.get(id);
        if (b) names[id] = b.name;
      }
      const campaign = await ctx.db.get(r.campaignId);
      const key = r.agentKeyId ? await ctx.db.get(r.agentKeyId) : null;
      out.push({
        ruleId: r._id,
        name: r.name,
        summary: summarizeRule(r, names),
        campaignId: r.campaignId,
        campaignBrief: campaign?.brief ?? "Deleted campaign",
        cities: r.cities ?? null,
        billboardIds: r.billboardIds ?? null,
        minMatch: r.minMatch ?? null,
        maxPriceMinor: r.maxPriceMinor,
        daysOfWeek: r.daysOfWeek ?? null,
        hourStart: r.hourStart ?? null,
        hourEnd: r.hourEnd ?? null,
        dateFrom: r.dateFrom ?? null,
        dateTo: r.dateTo ?? null,
        triggers: r.triggers,
        delivery: r.delivery,
        agentKey: key ? { agentKeyId: key._id, name: key.name, prefix: key.prefix, status: keyStatus(key, now) } : null,
        active: r.active,
        createdAt: r._creationTime,
      });
    }
    return out;
  },
});
