import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { recordAudit } from "./audit";

/**
 * Move a confirmed booking's not-yet-finished slots from `booked` to
 * `scheduled` (creative approved -> eligible to play). Slots that already
 * ended stay `booked`. Returns the number of slots scheduled.
 */
export async function scheduleBooking(
  ctx: MutationCtx,
  booking: Doc<"bookings">,
  now: number,
  actor: string,
): Promise<number> {
  if (booking.status !== "confirmed") return 0;
  const scheduled: string[] = [];
  for (const slotId of booking.slotIds) {
    const slot = await ctx.db.get(slotId);
    if (slot && slot.state === "booked" && slot.bookingId === booking._id && slot.endAt > now) {
      await ctx.db.patch(slotId, { state: "scheduled" });
      scheduled.push(slotId);
    }
  }
  if (scheduled.length === 0) return 0;
  await ctx.db.patch(booking._id, { status: "scheduled" });
  await recordAudit(ctx, {
    workspaceId: booking.workspaceId,
    traceId: booking.traceId,
    actor,
    type: "booking.scheduled",
    subjectId: booking._id,
    reason: `Approved creative scheduled on ${scheduled.length} slot(s)`,
    data: { slotIds: scheduled, campaignId: booking.campaignId },
  });
  return scheduled.length;
}
