import { v, type Infer } from "convex/values";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { financeExceptionKind, paymentProvider } from "./schema";
import { recordAudit } from "./lib/audit";
import { ACCEPTED_PAYMENT_ASSETS, MAX_KEY_LENGTH } from "./lib/constants";
import { scheduleBooking } from "./lib/scheduling";

/**
 * Result of reporting a verified payment. Discriminated on `outcome`:
 * - "booked":    booking confirmed (or, if replayed, was confirmed by the original report)
 * - "exception": payment recorded but NOT booked; a finance exception is open for review
 * - "rejected":  nothing recorded (unknown hold / invalid input); caller must fix the request
 */
export const recordVerifiedResult = v.union(
  v.object({
    outcome: v.literal("booked"),
    paymentId: v.id("payments"),
    bookingId: v.id("bookings"),
    replayed: v.boolean(),
  }),
  v.object({
    outcome: v.literal("exception"),
    paymentId: v.id("payments"),
    financeExceptionId: v.id("financeExceptions"),
    kind: financeExceptionKind,
    replayed: v.boolean(),
  }),
  v.object({
    outcome: v.literal("rejected"),
    code: v.union(v.literal("HOLD_NOT_FOUND"), v.literal("INVALID_INPUT")),
    message: v.string(),
  }),
);
export type RecordVerifiedResult = Infer<typeof recordVerifiedResult>;

/** Exception kinds this module can open (AR kinds live in lib/finance.ts). */
type ExceptionKind = Extract<
  Infer<typeof financeExceptionKind>,
  "payment_after_hold_expired" | "amount_mismatch" | "asset_mismatch" | "duplicate_payment"
>;

const NEXT_ACTION: Record<ExceptionKind, string> = {
  payment_after_hold_expired:
    "Operator review: re-hold equivalent inventory if available, otherwise issue an authorized refund. Do not auto-confirm.",
  amount_mismatch:
    "Operator review: collect the shortfall or refund the payment. Do not schedule until reconciled.",
  asset_mismatch:
    "Operator review: payment asset does not match quote currency; refund or convert under policy.",
  duplicate_payment:
    "Operator review: hold already paid; refund the duplicate payment.",
};

/** Replay: return exactly what the first report of this externalRef produced. */
async function outcomeOf(
  ctx: MutationCtx,
  payment: Doc<"payments">,
): Promise<RecordVerifiedResult> {
  if (payment.bookingId) {
    return {
      outcome: "booked",
      paymentId: payment._id,
      bookingId: payment.bookingId,
      replayed: true,
    };
  }
  if (payment.financeExceptionId) {
    const exception = await ctx.db.get(payment.financeExceptionId);
    if (exception) {
      return {
        outcome: "exception",
        paymentId: payment._id,
        financeExceptionId: exception._id,
        kind: exception.kind,
        replayed: true,
      };
    }
  }
  // Unreachable: every recorded payment gets a booking or an exception in the
  // same transaction it is inserted.
  throw new Error(`Payment ${payment._id} has no recorded outcome`);
}

type PaymentInput = {
  holdId: string;
  provider: Infer<typeof paymentProvider>;
  externalRef: string;
  amountMinor: number;
  asset: string;
  network?: string;
  idempotencyKey: string;
};

/**
 * Shared core of `recordVerified` and `recordManual`: decide book vs.
 * exception for a payment that has already been verified (or, for manual,
 * asserted by an operator). Idempotent on `externalRef`.
 */
async function applyVerifiedPayment(
  ctx: MutationCtx,
  args: PaymentInput,
  opts: { actor: string; reasonPrefix: string },
): Promise<RecordVerifiedResult> {
  const { actor, reasonPrefix } = opts;
  const invalid = (message: string): RecordVerifiedResult => ({
    outcome: "rejected",
    code: "INVALID_INPUT",
    message,
  });
  const bounded = (s: string, max: number) => s.trim().length > 0 && s.length <= max;
  if (!bounded(args.externalRef, 256)) return invalid("externalRef must be 1..256 chars");
  if (!bounded(args.idempotencyKey, MAX_KEY_LENGTH)) {
    return invalid(`idempotencyKey must be 1..${MAX_KEY_LENGTH} chars`);
  }
  if (!bounded(args.asset, 16)) return invalid("asset must be 1..16 chars");
  if (args.network !== undefined && !bounded(args.network, 64)) {
    return invalid("network must be 1..64 chars");
  }
  if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
    return invalid("amountMinor must be a positive integer (USD cents)");
  }

  // 1. Replay protection: one externalRef -> one outcome, forever.
  const prior = await ctx.db
    .query("payments")
    .withIndex("by_externalRef", (q) => q.eq("externalRef", args.externalRef))
    .first();
  if (prior) {
    const result = await outcomeOf(ctx, prior);
    const hold = await ctx.db.get(prior.holdId);
    await recordAudit(ctx, {
      traceId: hold?.traceId ?? `payment:${prior._id}`,
      actor,
      type: "payment.replayed",
      subjectId: prior._id,
      reason: `Duplicate report of externalRef ${args.externalRef}; returned original outcome "${result.outcome}"`,
      data: { externalRef: args.externalRef, observedMinor: args.amountMinor },
    });
    return result;
  }

  const holdId = ctx.db.normalizeId("holds", args.holdId);
  const hold = holdId ? await ctx.db.get(holdId) : null;
  if (!hold) {
    return { outcome: "rejected", code: "HOLD_NOT_FOUND", message: "Hold not found" };
  }

  const now = Date.now();
  
  // 2. Decide: book, or open a finance exception. Order matters.
  let exception: { kind: ExceptionKind; evidence: string } | null = null;
  if (hold.status === "converted") {
    exception = {
      kind: "duplicate_payment",
      evidence: `Hold ${hold._id} was already converted to a booking by a different payment; new externalRef ${args.externalRef}`,
    };
  } else if (hold.status !== "active" || now >= hold.expiresAt) {
    exception = {
      kind: "payment_after_hold_expired",
      evidence: `Payment observed at ${new Date(now).toISOString()} but hold status is "${hold.status}" with expiresAt ${new Date(hold.expiresAt).toISOString()}`,
    };
  } else if (!ACCEPTED_PAYMENT_ASSETS.includes(args.asset.toUpperCase())) {
    exception = {
      kind: "asset_mismatch",
      evidence: `Quote is ${hold.currency}; payment asset "${args.asset}" is not one of ${ACCEPTED_PAYMENT_ASSETS.join(", ")}`,
    };
  } else if (args.amountMinor !== hold.amountMinor) {
    exception = {
      kind: "amount_mismatch",
      evidence: `Expected ${hold.amountMinor} USD minor units, observed ${args.amountMinor}`,
    };
  } else {
    // Defensive: every slot must still be held by exactly this hold.
    for (const slotId of hold.slotIds) {
      const slot = await ctx.db.get(slotId);
      if (!slot || slot.state !== "held" || slot.holdId !== hold._id) {
        exception = {
          kind: "payment_after_hold_expired",
          evidence: `Slot ${slotId} is no longer held by hold ${hold._id}`,
        };
        break;
      }
    }
  }

  const paymentId: Id<"payments"> = await ctx.db.insert("payments", {
    holdId: hold._id,
    provider: args.provider,
    externalRef: args.externalRef,
    amountMinor: args.amountMinor,
    asset: args.asset,
    network: args.network,
    status: exception ? "exception" : "verified",
    idempotencyKey: args.idempotencyKey,
  });
  const paymentData = {
    holdId: hold._id,
    externalRef: args.externalRef,
    provider: args.provider,
    amountMinor: args.amountMinor,
    asset: args.asset,
    network: args.network ?? null,
  };

  if (exception) {
    const financeExceptionId = await ctx.db.insert("financeExceptions", {
      kind: exception.kind,
      status: "open",
      holdId: hold._id,
      billboardId: hold.billboardId,
      paymentId,
      expectedMinor: hold.amountMinor,
      observedMinor: args.amountMinor,
      evidence: exception.evidence,
      nextAction: NEXT_ACTION[exception.kind],
    });
    await ctx.db.patch(paymentId, { financeExceptionId });
    await recordAudit(ctx, {
      traceId: hold.traceId,
      actor,
      type: "payment.exception",
      subjectId: paymentId,
      reason: `${reasonPrefix}not applied: ${exception.kind}`,
      data: paymentData,
    });
    await recordAudit(ctx, {
      traceId: hold.traceId,
      actor: "system",
      type: "finance.exception_opened",
      subjectId: financeExceptionId,
      reason: exception.evidence,
      data: { kind: exception.kind, paymentId, holdId: hold._id },
    });
    return {
      outcome: "exception",
      paymentId,
      financeExceptionId,
      kind: exception.kind,
      replayed: false,
    };
  }

  // 3. Valid hold + matching amount: confirm.
  const quote = await ctx.db.get(hold.quoteId);
  if (!quote) throw new Error(`Quote ${hold.quoteId} missing for hold ${hold._id}`);
  const bookingId = await ctx.db.insert("bookings", {
    holdId: hold._id,
    quoteId: hold.quoteId,
    campaignId: quote.campaignId,
    billboardId: hold.billboardId,
    slotIds: hold.slotIds,
    amountMinor: hold.amountMinor,
    currency: hold.currency,
    paymentId,
    status: "confirmed",
    traceId: hold.traceId,
  });
  await ctx.db.patch(paymentId, { bookingId });
  for (const slotId of hold.slotIds) {
    await ctx.db.patch(slotId, { state: "booked", bookingId });
  }
  await ctx.db.patch(hold._id, { status: "converted" });
  await ctx.db.patch(hold.quoteId, { status: "accepted" });

  await recordAudit(ctx, {
    traceId: hold.traceId,
    actor,
    type: "payment.confirmed",
    subjectId: paymentId,
    reason: `${reasonPrefix}${args.amountMinor} USD minor units matches quote`,
    data: paymentData,
  });
  await recordAudit(ctx, {
    traceId: hold.traceId,
    actor: "system",
    type: "booking.confirmed",
    subjectId: bookingId,
    reason: `Booked ${hold.slotIds.length} slot(s) after verified payment`,
    data: { holdId: hold._id, quoteId: hold.quoteId, slotIds: hold.slotIds, paymentId },
  });

  // Creative already approved -> straight to scheduled (P0-07).
  const campaign = await ctx.db.get(quote.campaignId);
  if (campaign?.creativeStatus === "approved") {
    const booking = await ctx.db.get(bookingId);
    if (booking) await scheduleBooking(ctx, booking, now, "system");
  }

  return { outcome: "booked", paymentId, bookingId, replayed: false };
}

/**
 * Record a payment that an external verifier (x402 facilitator, Nessie,
 * manual) has already verified, and confirm the booking if and only if the
 * hold is still valid and the amount/asset match the quote.
 *
 * Idempotent on `externalRef`: a replayed report returns the original
 * outcome and never creates a second booking or payment.
 *
 * `amountMinor` is in USD cents; the reporting server converts asset units
 * (e.g. USDC 6-decimal atomic units) before calling.
 */
export const recordVerified = internalMutation({
  args: {
    /** String so an unknown/malformed id yields a clean "rejected" result, not a validator error. */
    holdId: v.string(),
    provider: paymentProvider,
    externalRef: v.string(),
    amountMinor: v.number(),
    asset: v.string(),
    network: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  returns: recordVerifiedResult,
  handler: async (ctx, args): Promise<RecordVerifiedResult> => {
    return await applyVerifiedPayment(ctx, args, {
      actor: `payment:${args.provider}`,
      reasonPrefix: "Verified payment ",
    });
  },
});

/**
 * Operator fallback until x402 is live: mark a hold as paid with a MANUAL
 * (simulated) payment of exactly the held amount in USD. Goes through the
 * same rules as verified payments (expired hold -> exception, replay-safe via
 * externalRef `manual:<holdId>`). Clearly labeled in the audit log.
 * TODO(auth): operator-only once auth exists; this is a public demo control.
 */
export const recordManual = mutation({
  args: { holdId: v.id("holds"), note: v.string() },
  returns: recordVerifiedResult,
  handler: async (ctx, args): Promise<RecordVerifiedResult> => {
    const note = args.note.trim().slice(0, 500);
    const hold = await ctx.db.get(args.holdId);
    if (!hold) {
      return { outcome: "rejected", code: "HOLD_NOT_FOUND", message: "Hold not found" };
    }
    const result = await applyVerifiedPayment(
      ctx,
      {
        holdId: args.holdId,
        provider: "manual",
        externalRef: `manual:${args.holdId}`,
        amountMinor: hold.amountMinor,
        asset: "USD",
        idempotencyKey: `manual:${args.holdId}`,
      },
      {
        actor: "operator",
        reasonPrefix: `MANUAL (simulated) payment${note ? ` [${note}]` : ""}: `,
      },
    );
    return result;
  },
});
