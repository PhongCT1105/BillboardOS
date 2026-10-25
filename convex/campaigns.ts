import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { audienceTags, campaignStatus, creativeStatus, currency } from "./schema";
import { validateTags } from "./lib/match";
import { requestResearch } from "./research";
import { requireCustomer, requireUser } from "./lib/tenancy";
import { recordAudit } from "./lib/audit";

const MAX_BRIEF_LENGTH = 4000;
const MAX_BUDGET_MINOR = 10_000_000; // $100k

export const campaignSummary = v.object({
  _id: v.id("campaigns"),
  _creationTime: v.number(),
  advertiserId: v.id("advertisers"),
  advertiserName: v.string(),
  brief: v.string(),
  targetCity: v.optional(v.string()),
  budgetMinor: v.number(),
  currency,
  status: campaignStatus,
  creativeStatus,
  creativeContentType: v.optional(v.string()),
  creativeReviewReason: v.optional(v.string()),
  targetAudience: v.optional(audienceTags),
});

/**
 * The caller's own campaigns (every company they act for, or one of them),
 * newest first (max 50). Customers never see other companies' campaigns.
 */
export const list = query({
  args: { advertiserId: v.optional(v.id("advertisers")) },
  returns: v.array(campaignSummary),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    let companyIds: Id<"advertisers">[];
    if (args.advertiserId) {
      await requireCustomer(ctx, args.advertiserId);
      companyIds = [args.advertiserId];
    } else {
      companyIds = (
        await ctx.db
          .query("advertiserMembers")
          .withIndex("by_user", (q) => q.eq("userId", user.userId))
          .take(20)
      ).map((m) => m.advertiserId);
    }
    const campaigns: Doc<"campaigns">[] = [];
    for (const advertiserId of companyIds) {
      campaigns.push(
        ...(await ctx.db
          .query("campaigns")
          .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId))
          .order("desc")
          .take(50)),
      );
    }
    campaigns.sort((a, b) => b._creationTime - a._creationTime);
    campaigns.splice(50);

    const names = new Map<Id<"advertisers">, string>();
    const rows = [];
    for (const c of campaigns) {
      let name = names.get(c.advertiserId);
      if (name === undefined) {
        name = (await ctx.db.get(c.advertiserId))?.displayName ?? "Unknown advertiser";
        names.set(c.advertiserId, name);
      }
      rows.push(toSummary(c, name));
    }
    return rows;
  },
});

function toSummary(c: Doc<"campaigns">, advertiserName: string) {
  return {
    _id: c._id,
    _creationTime: c._creationTime,
    advertiserId: c.advertiserId,
    advertiserName,
    brief: c.brief,
    targetCity: c.targetCity,
    budgetMinor: c.budgetMinor,
    currency: c.currency,
    status: c.status,
    creativeStatus: c.creativeStatus ?? ("none" as const),
    creativeContentType: c.creativeContentType,
    creativeReviewReason: c.creativeReviewReason,
    targetAudience: c.targetAudience,
  };
}

/** Create an active campaign for your company (default: your first company). Returns the new campaign id. */
export const create = mutation({
  args: {
    advertiserId: v.optional(v.id("advertisers")),
    brief: v.string(),
    targetCity: v.optional(v.string()),
    budgetMinor: v.number(),
    /** Who the campaign wants to reach, e.g. { software: 0.7, startups: 0.3 }. */
    targetAudience: v.optional(audienceTags),
  },
  returns: v.id("campaigns"),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx, args.advertiserId);
    const advertiserId = customer.advertiserId;
    const brief = args.brief.trim();
    if (brief.length === 0 || brief.length > MAX_BRIEF_LENGTH) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `brief must be 1..${MAX_BRIEF_LENGTH} characters`,
      });
    }
    const targetCity = args.targetCity?.trim() || undefined;
    if (targetCity !== undefined && targetCity.length > 100) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "targetCity too long" });
    }
    if (
      !Number.isSafeInteger(args.budgetMinor) ||
      args.budgetMinor <= 0 ||
      args.budgetMinor > MAX_BUDGET_MINOR
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `budgetMinor must be an integer in (0, ${MAX_BUDGET_MINOR}] (US cents)`,
      });
    }
    if (args.targetAudience) {
      const problem = validateTags(args.targetAudience);
      if (problem) throw new ConvexError({ code: "INVALID_INPUT", message: problem });
    }
    const advertiser = await ctx.db.get(advertiserId);
    if (!advertiser) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Advertiser not found" });
    }

    const campaignId = await ctx.db.insert("campaigns", {
      advertiserId,
      brief,
      targetCity,
      budgetMinor: args.budgetMinor,
      currency: "USD",
      status: "active",
      creativeStatus: "none",
      targetAudience: args.targetAudience,
    });
    // Research agent: learn who this company sells to and what the right crowd is worth to it.
    await requestResearch(ctx, advertiserId);
    await recordAudit(ctx, {
      traceId: `campaign:${campaignId}`,
      actor: customer.actor,
      type: "campaign.created",
      subjectId: campaignId,
      reason: `Campaign created for ${advertiser.displayName}`,
      data: { advertiserId, budgetMinor: args.budgetMinor, targetCity: targetCity ?? null },
    });
    return campaignId;
  },
});
