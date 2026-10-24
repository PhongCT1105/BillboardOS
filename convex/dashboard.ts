import { v } from "convex/values";
import { query } from "./_generated/server";
import { resolveWorkspace } from "./lib/tenancy";

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BILLBOARDS = 20;
const MAX_SLOTS_PER_BILLBOARD = 1000;
const MAX_BOOKINGS_PER_BILLBOARD = 1000;
const MAX_EXCEPTIONS_PER_BILLBOARD = 200;

const slotCounts = v.object({
  available: v.number(),
  held: v.number(),
  booked: v.number(),
  scheduled: v.number(),
  played: v.number(),
  failed_delivery: v.number(),
});

/**
 * Operator overview (P0-09). Slot counts cover slots starting within
 * [now - 24h, now + 7d]. Revenue = sum of non-failed bookings (cash collected
 * via verified payments). All reads are bounded; `truncated` flags a cap hit.
 */
export const summary = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({
    generatedAt: v.number(),
    billboards: v.array(
      v.object({
        billboardId: v.id("billboards"),
        name: v.string(),
        city: v.string(),
        deviceStatus: v.union(v.literal("online"), v.literal("offline")),
        slotCounts,
        confirmedRevenueMinor: v.number(),
        bookingsCount: v.number(),
        openExceptions: v.number(),
        truncated: v.boolean(),
      }),
    ),
    totals: v.object({
      confirmedRevenueMinor: v.number(),
      openExceptions: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const now = Date.now();
    const billboards = await ctx.db
      .query("billboards")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .take(MAX_BILLBOARDS);

    const rows = [];
    for (const billboard of billboards) {
      const slots = await ctx.db
        .query("slots")
        .withIndex("by_billboard_and_startAt", (q) =>
          q
            .eq("billboardId", billboard._id)
            .gte("startAt", now - LOOKBACK_MS)
            .lte("startAt", now + LOOKAHEAD_MS),
        )
        .take(MAX_SLOTS_PER_BILLBOARD);
      const counts = {
        available: 0,
        held: 0,
        booked: 0,
        scheduled: 0,
        played: 0,
        failed_delivery: 0,
      };
      for (const slot of slots) counts[slot.state] += 1;

      const bookings = await ctx.db
        .query("bookings")
        .withIndex("by_billboard", (q) => q.eq("billboardId", billboard._id))
        .take(MAX_BOOKINGS_PER_BILLBOARD);
      const paid = bookings.filter((b) => b.status !== "failed");
      const revenue = paid.reduce((sum, b) => sum + b.amountMinor, 0);

      const exceptions = await ctx.db
        .query("financeExceptions")
        .withIndex("by_billboard_and_status", (q) =>
          q.eq("billboardId", billboard._id).eq("status", "open"),
        )
        .take(MAX_EXCEPTIONS_PER_BILLBOARD);

      rows.push({
        billboardId: billboard._id,
        name: billboard.name,
        city: billboard.city,
        deviceStatus: billboard.deviceStatus,
        slotCounts: counts,
        confirmedRevenueMinor: revenue,
        bookingsCount: paid.length,
        openExceptions: exceptions.length,
        truncated:
          slots.length === MAX_SLOTS_PER_BILLBOARD ||
          bookings.length === MAX_BOOKINGS_PER_BILLBOARD ||
          exceptions.length === MAX_EXCEPTIONS_PER_BILLBOARD,
      });
    }

    return {
      generatedAt: now,
      billboards: rows,
      totals: {
        confirmedRevenueMinor: rows.reduce((s, r) => s + r.confirmedRevenueMinor, 0),
        openExceptions: rows.reduce((s, r) => s + r.openExceptions, 0),
      },
    };
  },
});
