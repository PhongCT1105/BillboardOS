import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { recordAudit } from "./lib/audit";
import { effectiveBaseline } from "./lib/pricing";
import { billboardDoc } from "./lib/validators";
import { requireOperator } from "./lib/operator";

/** All billboards (bounded; inventory is small). */
export const list = query({
  args: {},
  returns: v.array(billboardDoc),
  handler: async (ctx) => {
    return await ctx.db.query("billboards").take(100);
  },
});

const MAX_BASELINE = 100_000;

/**
 * Operator: set this screen's "normal traffic" (people per 15 min). Demand
 * pricing compares measured audience against it.
 * Operator only.
 */
export const setAudienceBaseline = mutation({
  args: { billboardId: v.id("billboards"), peoplePer15Min: v.number() },
  returns: v.object({
    billboardId: v.id("billboards"),
    previous: v.number(),
    audienceBaselinePerBucket: v.number(),
  }),
  handler: async (ctx, args) => {
    const operator = await requireOperator(ctx);
    if (
      !Number.isSafeInteger(args.peoplePer15Min) ||
      args.peoplePer15Min < 1 ||
      args.peoplePer15Min > MAX_BASELINE
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `peoplePer15Min must be an integer in [1, ${MAX_BASELINE}]`,
      });
    }
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) throw new ConvexError({ code: "NOT_FOUND", message: "Billboard not found" });
    const previous = effectiveBaseline(billboard.audienceBaselinePerBucket);
    await ctx.db.patch(billboard._id, { audienceBaselinePerBucket: args.peoplePer15Min });
    await recordAudit(ctx, {
      traceId: `billboard:${billboard._id}`,
      actor: operator.actor,
      type: "billboard.baseline_changed",
      subjectId: billboard._id,
      reason: `Normal traffic for ${billboard.name} changed from ${previous} to ${args.peoplePer15Min} people per 15 min`,
      data: { previous, next: args.peoplePer15Min },
    });
    return {
      billboardId: billboard._id,
      previous,
      audienceBaselinePerBucket: args.peoplePer15Min,
    };
  },
});
