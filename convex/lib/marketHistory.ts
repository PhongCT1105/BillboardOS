import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { hourBand } from "./pricing";
import { normalizedSaleRatio } from "./screenPrice";

/** Record each sold slot of a booking as market evidence (equal split of the booking amount). */
export async function recordSaleHistory(
  ctx: MutationCtx,
  booking: Doc<"bookings">,
  kind: "posted" | "terms" | "auction",
  now: number,
): Promise<void> {
  const billboard = await ctx.db.get(booking.billboardId);
  if (!billboard || booking.slotIds.length === 0) return;
  const unit = Math.round(booking.amountMinor / booking.slotIds.length);
  for (const slotId of booking.slotIds) {
    const slot = await ctx.db.get(slotId);
    if (!slot) continue;
    await ctx.db.insert("priceHistory", {
      billboardId: billboard._id,
      workspaceId: billboard.workspaceId,
      slotId,
      slotStartAt: slot.startAt,
      hourBand: hourBand(slot.startAt, billboard.utcOffsetMinutes),
      unitPriceMinor: unit,
      normalizedRatio: normalizedSaleRatio(billboard, slot.startAt, unit),
      kind,
      recordedAt: now,
    });
  }
}
