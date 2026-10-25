import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { hourBand } from "./pricing";
import { normalizedSaleRatio } from "./screenPrice";
import { SLOT_MS } from "./moment";

/** Record each sold slot of a booking as market evidence (equal split of the booking amount; `coveredMs` under a slot scales it up to a full-slot equivalent). */
export async function recordSaleHistory(
  ctx: MutationCtx,
  booking: Doc<"bookings">,
  kind: "posted" | "terms" | "auction",
  now: number,
  coveredMs?: number,
): Promise<void> {
  const billboard = await ctx.db.get(booking.billboardId);
  if (!billboard || booking.slotIds.length === 0) return;
  // A partial slot (live moment) is recorded at its full-slot equivalent so it doesn't drag prices down.
  const scale = coveredMs !== undefined && coveredMs > 0 && coveredMs < SLOT_MS ? SLOT_MS / coveredMs : 1;
  const unit = Math.round((booking.amountMinor * scale) / booking.slotIds.length);
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
