import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { recordAudit } from "./lib/audit";

const SLOT_MS = 15 * 60 * 1000;
const SLOT_COUNT = 48;
const BILLBOARD_NAME = "Moscone West Screen";

/**
 * Idempotent demo seed (`npm run seed`). Creates, only if missing:
 * one San Francisco billboard with 48 fifteen-minute slots starting at the
 * next quarter hour, two advertisers, and one active campaign.
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
      const now = Date.now();
      const firstStart = Math.ceil((now + 1) / SLOT_MS) * SLOT_MS;
      for (let i = 0; i < SLOT_COUNT; i++) {
        const startAt = firstStart + i * SLOT_MS;
        await ctx.db.insert("slots", {
          billboardId,
          startAt,
          endAt: startAt + SLOT_MS,
          state: "available",
        });
        slotsCreated++;
      }
      billboard = (await ctx.db.get(billboardId))!;
    }

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
