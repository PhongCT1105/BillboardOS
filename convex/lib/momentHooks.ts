import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { recordAudit } from "./audit";
import { NEXT_SPOT_LEAD_MS } from "./liveAuction";

/**
 * Small hooks the payment and player code call so the live-moment timeline
 * (ADR 0006) stays complete. No imports of payments/moments modules (no cycles).
 */

const MAX_STEPS = 60;

export async function addMomentStep(
  ctx: MutationCtx,
  moment: Doc<"moments">,
  key: string,
  label: string,
  detail?: string,
  at = Date.now(),
): Promise<void> {
  const fresh = (await ctx.db.get(moment._id)) ?? moment;
  const steps = [...fresh.steps, { key, label, at, detail: detail?.slice(0, 600) }].slice(-MAX_STEPS);
  await ctx.db.patch(moment._id, { steps });
}

/** A campaign's creative can play on this host's screens: approved platform-wide or by this host. */
export async function creativeReady(
  ctx: QueryCtx,
  campaign: Doc<"campaigns">,
  workspaceId: Id<"workspaces"> | undefined,
): Promise<boolean> {
  if (!campaign.creativeStorageId) return false;
  if (campaign.creativeStatus === "approved") return true;
  if (!workspaceId) return false;
  const approval = await ctx.db
    .query("creativeApprovals")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId).eq("campaignId", campaign._id))
    .first();
  return approval !== null;
}

export function isRehearsalRef(externalRef: string) {
  return externalRef.startsWith("rehearsal:");
}

/** Payment applied and booking confirmed for a moment's hold. */
export async function onMomentPaid(
  ctx: MutationCtx,
  holdId: Id<"holds">,
  bookingId: Id<"bookings">,
  payment: { provider: string; externalRef: string; network?: string; amountMinor: number },
): Promise<void> {
  const moment = await ctx.db
    .query("moments")
    .withIndex("by_hold", (q) => q.eq("holdId", holdId))
    .first();
  if (!moment) return;
  const rehearsal = isRehearsalRef(payment.externalRef);
  const now = Date.now();
  await ctx.db.patch(moment._id, {
    status: "paid",
    bookingId,
    paidMinor: payment.amountMinor,
    paymentMode: rehearsal ? "rehearsal" : "x402",
    paymentTx: rehearsal ? undefined : payment.externalRef,
    paymentNetwork: payment.network,
  });
  await addMomentStep(
    ctx,
    moment,
    "settled",
    rehearsal ? "REHEARSAL (simulated) payment recorded" : "Settled over x402",
    rehearsal
      ? `No money moved: rehearsal settlement for $${(payment.amountMinor / 100).toFixed(2)} (host toggle).`
      : `$${(payment.amountMinor / 100).toFixed(2)} USDC, tx ${payment.externalRef}${payment.network ? ` on ${payment.network}` : ""}`,
    now,
  );
  // No dead air: the next spot on this screen goes on sale a minute before this one ends.
  await ctx.scheduler.runAt(Math.max(now, moment.spotEndAt - NEXT_SPOT_LEAD_MS), internal.moments.detectFor, {
    billboardId: moment.billboardId,
    trigger: "next_spot",
  });
  const booking = await ctx.db.get(bookingId);
  if (booking?.status === "scheduled") {
    await addMomentStep(ctx, moment, "scheduled", "Scheduled on the screen", "The player picks it up through its live query.", now);
  }
  await recordAudit(ctx, {
    workspaceId: moment.workspaceId,
    traceId: `moment:${moment._id}`,
    actor: rehearsal ? "REHEARSAL (simulated) payment" : `payment:${payment.provider}`,
    type: "moment.paid",
    subjectId: moment._id,
    reason: rehearsal
      ? `REHEARSAL (simulated) payment of $${(payment.amountMinor / 100).toFixed(2)}; no money moved`
      : `Flash spot paid $${(payment.amountMinor / 100).toFixed(2)} over x402 (tx ${payment.externalRef})`,
  });
}

/** The player reported the first frame of a moment's booking: stop the stopwatch. */
export async function onMomentFirstFrame(ctx: MutationCtx, bookingId: Id<"bookings">, at: number): Promise<void> {
  const moment = await ctx.db
    .query("moments")
    .withIndex("by_booking", (q) => q.eq("bookingId", bookingId))
    .first();
  if (!moment || moment.firstFrameAt !== undefined) return;
  await ctx.db.patch(moment._id, { status: "playing", firstFrameAt: at, durationMs: at - moment.startedAt });
  await addMomentStep(ctx, moment, "first_frame", "First frame on screen", `${((at - moment.startedAt) / 1000).toFixed(1)} s after the crowd was detected`, at);
}
