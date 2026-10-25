import { ConvexError, v } from "convex/values";
import { mutation, query, env } from "./_generated/server";
import { assertBoundedString } from "./lib/validators";
import { resolveWorkspace } from "./lib/tenancy";

const ROLES = [
  { id: "sales", label: "Sales qualification", wired: true },
  { id: "revenue", label: "Revenue pricing", wired: true },
  { id: "company_research", label: "Company research", wired: true },
  { id: "screen_audience", label: "Screen audience", wired: true },
  { id: "creative_safety", label: "Creative safety", wired: true },
  { id: "price_refine", label: "Price refine", wired: true },
  { id: "invite_rotate", label: "Invite rotate", wired: true },
  { id: "opportunity_strategy", label: "Opportunity strategy", wired: false },
] as const;

function ready(id: string | undefined, key: string | undefined): boolean {
  return typeof id === "string" && id.length > 0 && typeof key === "string" && key.startsWith("capi_");
}

function configured(id: (typeof ROLES)[number]["id"]): boolean {
  switch (id) {
    case "sales":
      return ready(env.CREAO_SALES_AGENT_ID, env.CREAO_SALES_API_KEY);
    case "revenue":
      return ready(env.CREAO_REVENUE_AGENT_ID, env.CREAO_REVENUE_API_KEY);
    case "company_research":
      return ready(env.CREAO_COMPANY_RESEARCH_AGENT_ID, env.CREAO_COMPANY_RESEARCH_API_KEY);
    case "screen_audience":
      return ready(env.CREAO_SCREEN_AUDIENCE_AGENT_ID, env.CREAO_SCREEN_AUDIENCE_API_KEY);
    case "creative_safety":
      return ready(env.CREAO_CREATIVE_SAFETY_AGENT_ID, env.CREAO_CREATIVE_SAFETY_API_KEY);
    case "price_refine":
      return ready(env.CREAO_PRICE_REFINE_AGENT_ID, env.CREAO_PRICE_REFINE_API_KEY);
    case "invite_rotate":
      return ready(env.CREAO_INVITE_ROTATE_AGENT_ID, env.CREAO_INVITE_ROTATE_API_KEY);
    case "opportunity_strategy":
      return ready(env.CREAO_OPPORTUNITY_STRATEGY_AGENT_ID, env.CREAO_OPPORTUNITY_STRATEGY_API_KEY);
  }
}

/** Which CREAO roles this deployment can call. Keys stay on the server. */
export const roster = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.string(),
      label: v.string(),
      configured: v.boolean(),
      wired: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    await resolveWorkspace(ctx);
    return ROLES.map((role) => ({
      id: role.id,
      label: role.label,
      configured: configured(role.id),
      wired: role.wired,
    }));
  },
});

const handoffValidator = v.object({
  _id: v.id("creaoHandoffs"),
  _creationTime: v.number(),
  traceId: v.string(),
  snapshotId: v.string(),
  mode: v.literal("simulated_rehearsal"),
  selectedCampaigns: v.array(v.string()),
  pricingPlans: v.number(),
  preparedOffers: v.number(),
  deliveredOffers: v.literal(0),
  summary: v.string(),
});

/** Newest Sales → Revenue handoff for this workspace, if one has been saved. */
export const latest = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.union(handoffValidator, v.null()),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const row = await ctx.db
      .query("creaoHandoffs")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .order("desc")
      .first();
    if (!row) return null;
    return {
      _id: row._id,
      _creationTime: row._creationTime,
      traceId: row.traceId,
      snapshotId: row.snapshotId,
      mode: row.mode,
      selectedCampaigns: row.selectedCampaigns,
      pricingPlans: row.pricingPlans,
      preparedOffers: row.preparedOffers,
      deliveredOffers: row.deliveredOffers,
      summary: row.summary,
    };
  },
});

/**
 * Save a finished CREAO rehearsal. The caller has already checked that Sales
 * prepared offers and delivered none. This writes that fact; it does not book,
 * bid, or charge.
 */
export const record = mutation({
  args: {
    traceId: v.string(),
    snapshotId: v.string(),
    selectedCampaigns: v.array(v.string()),
    pricingPlans: v.number(),
    preparedOffers: v.number(),
    workspaceId: v.optional(v.id("workspaces")),
  },
  returns: v.id("creaoHandoffs"),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    assertBoundedString("traceId", args.traceId, 80);
    assertBoundedString("snapshotId", args.snapshotId, 80);
    if (args.selectedCampaigns.length < 1 || args.selectedCampaigns.length > 12) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "selectedCampaigns must list 1..12 campaigns" });
    }
    for (const id of args.selectedCampaigns) assertBoundedString("campaign id", id, 80);
    if (!Number.isInteger(args.pricingPlans) || args.pricingPlans < 1 || args.pricingPlans > 20) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "pricingPlans must be an integer from 1 to 20" });
    }
    if (!Number.isInteger(args.preparedOffers) || args.preparedOffers < 0 || args.preparedOffers > 20) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "preparedOffers must be an integer from 0 to 20" });
    }
    const summary =
      `Sales qualified ${args.selectedCampaigns.length} campaigns. ` +
      `Revenue returned ${args.pricingPlans} pricing plan${args.pricingPlans === 1 ? "" : "s"}. ` +
      `Sales prepared ${args.preparedOffers} offer${args.preparedOffers === 1 ? "" : "s"} and delivered 0. ` +
      "No buyer was contacted and no inventory changed.";
    return await ctx.db.insert("creaoHandoffs", {
      workspaceId: me.workspaceId,
      traceId: args.traceId,
      snapshotId: args.snapshotId,
      mode: "simulated_rehearsal",
      selectedCampaigns: args.selectedCampaigns,
      pricingPlans: args.pricingPlans,
      preparedOffers: args.preparedOffers,
      deliveredOffers: 0,
      summary,
    });
  },
});
