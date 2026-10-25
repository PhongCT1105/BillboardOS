import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./audit";
import { isTxHash } from "./momentHooks";

/**
 * Payment applied and booking confirmed for a bidding round's hold
 * (payments.ts calls this next to onMomentPaid). Only a real settlement
 * transaction hash counts as proof of payment.
 */
export async function onRoundPaid(
  ctx: MutationCtx,
  holdId: Id<"holds">,
  bookingId: Id<"bookings">,
  payment: { provider: string; externalRef: string; network?: string; amountMinor: number },
): Promise<void> {
  const round = await ctx.db
    .query("rounds")
    .withIndex("by_hold", (q) => q.eq("holdId", holdId))
    .first();
  if (!round || round.status === "paid") return;
  const tx = isTxHash(payment.externalRef) ? payment.externalRef : undefined;
  const paid = `Paid $${(payment.amountMinor / 100).toFixed(2)} over x402${tx ? "" : " (no transaction hash reported)"}.`;
  await ctx.db.patch(round._id, {
    status: "paid",
    paymentTx: tx,
    paymentNetwork: payment.network,
    outcome: `${round.outcome ?? ""} ${paid}`.trim(),
  });
  await recordAudit(ctx, {
    workspaceId: round.workspaceId,
    traceId: `round:${round._id}`,
    actor: `payment:${payment.provider}`,
    type: "round.paid",
    subjectId: round._id,
    reason: `${paid} Booking ${bookingId}${tx ? `, tx ${tx}` : ""}`,
  });
}
