import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export const SLOT_MS = 15 * 60 * 1000;
/** Keep this much future inventory available on every billboard. */
export const INVENTORY_HORIZON_MS = 12 * 60 * 60 * 1000;
/** Upper bound on slots created per billboard per call (12h of 15-min slots). */
const MAX_NEW_SLOTS = INVENTORY_HORIZON_MS / SLOT_MS;

/**
 * Append 15-minute slots for one billboard so inventory extends to
 * now + 12h. Idempotent: starts after the latest existing slot, so repeated
 * calls create nothing new until time moves forward. Returns slots created.
 */
export async function ensureUpcomingSlots(
  ctx: MutationCtx,
  billboardId: Id<"billboards">,
  now: number,
): Promise<number> {
  const latest = await ctx.db
    .query("slots")
    .withIndex("by_billboard_and_startAt", (q) => q.eq("billboardId", billboardId))
    .order("desc")
    .first();

  const nextQuarter = Math.ceil((now + 1) / SLOT_MS) * SLOT_MS;
  let startAt = latest ? Math.max(latest.endAt, nextQuarter) : nextQuarter;
  const horizon = now + INVENTORY_HORIZON_MS;

  let created = 0;
  while (startAt < horizon && created < MAX_NEW_SLOTS) {
    await ctx.db.insert("slots", {
      billboardId,
      startAt,
      endAt: startAt + SLOT_MS,
      state: "available",
    });
    startAt += SLOT_MS;
    created++;
  }
  return created;
}
