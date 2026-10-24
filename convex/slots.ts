import { ConvexError, v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { recordAudit } from "./lib/audit";
import { ensureUpcomingSlots } from "./lib/inventory";
import { slotDoc } from "./lib/validators";

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SLOTS = 200;

/** Slots on one billboard whose start time is in [from, to], oldest first (max 200, window <= 7 days). */
export const listForBillboard = query({
  args: {
    billboardId: v.id("billboards"),
    from: v.number(),
    to: v.number(),
  },
  returns: v.array(slotDoc),
  handler: async (ctx, args) => {
    if (
      !Number.isFinite(args.from) ||
      !Number.isFinite(args.to) ||
      args.to < args.from ||
      args.to - args.from > MAX_WINDOW_MS
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "Require finite from <= to with a window of at most 7 days",
      });
    }
    return await ctx.db
      .query("slots")
      .withIndex("by_billboard_and_startAt", (q) =>
        q.eq("billboardId", args.billboardId).gte("startAt", args.from).lte("startAt", args.to),
      )
      .take(MAX_SLOTS);
  },
});

const MAX_BILLBOARDS = 20;

/**
 * Cron (every 15 min, see crons.ts) + seed: keep 12h of 15-minute slots ahead
 * on every billboard. Idempotent and bounded (<= 48 new slots per billboard).
 */
export const ensureUpcoming = internalMutation({
  args: {},
  returns: v.object({ billboards: v.number(), slotsCreated: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const billboards = await ctx.db.query("billboards").take(MAX_BILLBOARDS);
    let slotsCreated = 0;
    for (const billboard of billboards) {
      const created = await ensureUpcomingSlots(ctx, billboard._id, now);
      if (created > 0) {
        slotsCreated += created;
        await recordAudit(ctx, {
          traceId: `inventory:${billboard._id}`,
          actor: "system",
          type: "inventory.generated",
          subjectId: billboard._id,
          reason: `Added ${created} upcoming 15-minute slot(s)`,
          data: { created },
        });
      }
    }
    return { billboards: billboards.length, slotsCreated };
  },
});
