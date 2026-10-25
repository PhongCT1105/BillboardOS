import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { audienceTags } from "./schema";
import { validateTags } from "./lib/match";
import { recordAudit } from "./lib/audit";
import { billboardDoc } from "./lib/validators";
import { requireWorkspaceMember, resolveWorkspace, workspaceOfBillboard } from "./lib/tenancy";
import { ensureUpcomingSlots } from "./lib/inventory";

/** All billboards (bounded; inventory is small). */
export const list = query({
  args: {},
  returns: v.array(billboardDoc),
  handler: async (ctx) => {
    return (await ctx.db.query("billboards").take(200)).filter((b) => b.retiredAt === undefined);
  },
});


/** Host: the least a spot on this screen sells for (every offer starts from it). */
export const setFloor = mutation({
  args: { billboardId: v.id("billboards"), floorMinor: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
    if (!Number.isSafeInteger(args.floorMinor) || args.floorMinor <= 0 || args.floorMinor > 100_000) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Floor must be whole cents, $0.01 to $1000" });
    }
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    await ctx.db.patch(billboard._id, { reserveFloorMinor: args.floorMinor, baseRateMinor: Math.max(billboard.baseRateMinor, args.floorMinor) });
    await recordAudit(ctx, {
      workspaceId: billboard.workspaceId,
      traceId: `billboard:${billboard._id}`,
      actor: member.actor,
      type: "billboard.floor_changed",
      subjectId: billboard._id,
      reason: `Floor for ${billboard.name} set to $${(args.floorMinor / 100).toFixed(2)} (was $${(billboard.reserveFloorMinor / 100).toFixed(2)})`,
    });
    return null;
  },
});

/** Host: how many people are usually in view of this screen (the crowd signal compares the camera's count with it). */
export const setUsualInView = mutation({
  args: { billboardId: v.id("billboards"), usualInView: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
    if (!Number.isInteger(args.usualInView) || args.usualInView < 1 || args.usualInView > 10_000) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "usualInView must be a whole number of people, 1 to 10000" });
    }
    await ctx.db.patch(args.billboardId, { usualInView: args.usualInView });
    return null;
  },
});

/** Operator: set who is likely in front of this screen (used for matching, not price). */
export const setAudienceTags = mutation({
  args: { billboardId: v.id("billboards"), audienceTags },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operator = await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
    const problem = validateTags(args.audienceTags);
    if (problem) throw new ConvexError({ code: "INVALID_INPUT", message: problem });
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    await ctx.db.patch(billboard._id, { audienceTags: args.audienceTags });
    await recordAudit(ctx, {
      workspaceId: billboard.workspaceId,
      traceId: `billboard:${billboard._id}`,
      actor: operator.actor,
      type: "billboard.audience_tags_changed",
      subjectId: billboard._id,
      reason: `Audience profile for ${billboard.name} set to ${Object.entries(args.audienceTags).map(([k, w]) => `${k} ${w}`).join(", ")}`,
    });
    return null;
  },
});

/** Screens of the caller's (active) workspace. */
export const mine = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(billboardDoc),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    return await ctx.db
      .query("billboards")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .take(100);
  },
});

/** Tests and seeds: add a screen without a device (real screens come from pairing, devices.claim). */
export const create = internalMutation({
  args: {
    workspaceId: v.optional(v.id("workspaces")),
    name: v.string(),
    city: v.string(),
    locationLabel: v.string(),
    utcOffsetMinutes: v.number(),
    baseRateMinor: v.number(),
    reserveFloorMinor: v.number(),
  },
  returns: v.id("billboards"),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const name = args.name.trim();
    const city = args.city.trim();
    const locationLabel = args.locationLabel.trim();
    if ([name, city, locationLabel].some((x) => x.length === 0 || x.length > 120)) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Name, city and location must be 1..120 characters" });
    }
    if (!Number.isInteger(args.utcOffsetMinutes) || Math.abs(args.utcOffsetMinutes) > 14 * 60) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "utcOffsetMinutes must be an integer within +-840" });
    }
    for (const [label, value] of [["baseRateMinor", args.baseRateMinor], ["reserveFloorMinor", args.reserveFloorMinor]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) {
        throw new ConvexError({ code: "INVALID_INPUT", message: `${label} must be an integer in (0, 1000000] (US cents)` });
      }
    }
    if (args.reserveFloorMinor > args.baseRateMinor) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Reserve floor can't exceed the base rate" });
    }
    const existing = await ctx.db
      .query("billboards")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (existing) throw new ConvexError({ code: "NAME_TAKEN", message: "A screen with this name already exists" });
    const billboardId = await ctx.db.insert("billboards", {
      workspaceId: me.workspaceId,
      name,
      city,
      locationLabel,
      utcOffsetMinutes: args.utcOffsetMinutes,
      baseRateMinor: args.baseRateMinor,
      reserveFloorMinor: args.reserveFloorMinor,
      deviceStatus: "online",
    });
    const slots = await ensureUpcomingSlots(ctx, billboardId, Date.now());
    await recordAudit(ctx, {
      workspaceId: me.workspaceId,
      traceId: `billboard:${billboardId}`,
      actor: me.actor,
      type: "inventory.generated",
      subjectId: billboardId,
      reason: `${me.email} added screen ${name} (${city}) with ${slots} upcoming slot(s)`,
    });
    return billboardId;
  },
});
