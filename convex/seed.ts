import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { ensureUpcomingSlots } from "./lib/inventory";

const BILLBOARD_NAME = "Moscone West Screen";

/**
 * Idempotent demo seed (`npm run seed`). Creates, only if missing:
 * one San Francisco billboard, 15-minute slots for the next 12 hours (topped
 * up on every run), two advertisers, and one active campaign.
 */
export const demo = internalMutation({
  args: {},
  returns: v.object({
    created: v.boolean(),
    billboardId: v.id("billboards"),
    advertiserIds: v.array(v.id("advertisers")),
    campaignId: v.id("campaigns"),
    slotsCreated: v.number(),
  }),
  handler: async (ctx) => {
    let created = false;

    let billboard = await ctx.db
      .query("billboards")
      .withIndex("by_name", (q) => q.eq("name", BILLBOARD_NAME))
      .first();
    let slotsCreated = 0;
    if (!billboard) {
      created = true;
      const billboardId = await ctx.db.insert("billboards", {
        name: BILLBOARD_NAME,
        city: "San Francisco",
        locationLabel: "Moscone Center West, 800 Howard St, San Francisco, CA",
        utcOffsetMinutes: -420, // PDT (Cal Hacks weekend)
        reserveFloorMinor: 2000, // $20
        baseRateMinor: 4000, // $40
        deviceStatus: "online",
      });
      billboard = (await ctx.db.get(billboardId))!;
    }
    // Rolling 12h of 15-minute slots (same helper the cron uses).
    slotsCreated = await ensureUpcomingSlots(ctx, billboard._id, Date.now());
    if (slotsCreated > 0) created = true;

    const advertiserSpecs = [
      { displayName: "Golden Gate Coffee Co.", paymentTerms: "prepay" as const },
      { displayName: "Bay Robotics", paymentTerms: "net15" as const },
    ];
    const advertiserIds: Id<"advertisers">[] = [];
    for (const spec of advertiserSpecs) {
      const existing = await ctx.db
        .query("advertisers")
        .withIndex("by_displayName", (q) => q.eq("displayName", spec.displayName))
        .first();
      if (existing) {
        advertiserIds.push(existing._id);
      } else {
        created = true;
        advertiserIds.push(await ctx.db.insert("advertisers", spec));
      }
    }

    let campaign = await ctx.db
      .query("campaigns")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserIds[0]))
      .first();
    if (!campaign) {
      created = true;
      const campaignId = await ctx.db.insert("campaigns", {
        advertiserId: advertiserIds[0],
        brief: "Morning coffee promo for Cal Hacks attendees near Moscone West; 2-4 slots, 7-10am.",
        targetCity: "San Francisco",
        budgetMinor: 30000, // $300
        currency: "USD",
        status: "active",
        creativeStatus: "none",
      });
      campaign = (await ctx.db.get(campaignId))!;
    }

    if (created) {
      await recordAudit(ctx, {
        traceId: "seed:demo",
        actor: "system",
        type: "seed.completed",
        subjectId: billboard._id,
        reason: `Seeded demo inventory (${slotsCreated} new slots)`,
        data: { campaignId: campaign._id, slotsCreated },
      });
    }

    return {
      created,
      billboardId: billboard._id,
      advertiserIds,
      campaignId: campaign._id,
      slotsCreated,
    };
  },
});
