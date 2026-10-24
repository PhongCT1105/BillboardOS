import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { currency, holdStatus } from "./schema";
import { recordAudit } from "./lib/audit";
import { HOLD_TTL_MS, MAX_KEY_LENGTH } from "./lib/constants";
import { assertBoundedString } from "./lib/validators";

const holdResult = v.object({
  holdId: v.id("holds"),
  quoteId: v.id("quotes"),
  slotIds: v.array(v.id("slots")),
  amountMinor: v.number(),
  currency,
  expiresAt: v.number(),
  status: holdStatus,
  traceId: v.string(),
  /** true when an existing hold was returned for a repeated idempotencyKey. */
  replayed: v.boolean(),
});

function toResult(hold: Doc<"holds">, replayed: boolean) {
  return {
    holdId: hold._id,
    quoteId: hold.quoteId,
    slotIds: hold.slotIds,
    amountMinor: hold.amountMinor,
    currency: hold.currency,
    expiresAt: hold.expiresAt,
    status: hold.status,
    traceId: hold.traceId,
    replayed,
  };
}

/**
 * Atomically take an exclusive, expiring hold on every slot in a quote.
 *
 * - Same idempotencyKey (for the same quote) returns the existing hold.
 * - Any slot not available -> ConvexError { code: "SLOT_UNAVAILABLE" }, nothing written.
 * - Expiry is scheduled at `expiresAt` via `internal.holds.expire`.
 */
export const create = mutation({
  args: {
    quoteId: v.id("quotes"),
    idempotencyKey: v.string(),
    actor: v.string(),
  },
  returns: holdResult,
  handler: async (ctx, args) => {
    assertBoundedString("idempotencyKey", args.idempotencyKey, MAX_KEY_LENGTH);
    assertBoundedString("actor", args.actor, MAX_KEY_LENGTH);

    const existing = await ctx.db
      .query("holds")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existing) {
      if (existing.quoteId !== args.quoteId) {
        throw new ConvexError({
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "idempotencyKey was already used for a different quote",
        });
      }
      return toResult(existing, true);
    }

    const now = Date.now();
    const quote = await ctx.db.get(args.quoteId);
    if (!quote) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Quote not found" });
    }
    if (quote.status !== "open" || now >= quote.expiresAt) {
      throw new ConvexError({
        code: "QUOTE_NOT_OPEN",
        message: quote.status === "open" ? "Quote has expired" : `Quote is ${quote.status}`,
      });
    }

    const slots: Doc<"slots">[] = [];
    for (const slotId of quote.slotIds) {
      const slot = await ctx.db.get(slotId);
      if (!slot || slot.state !== "available" || slot.startAt <= now) {
        throw new ConvexError({
          code: "SLOT_UNAVAILABLE",
          message: "One or more quoted slots are no longer available",
          slotId,
        });
      }
      slots.push(slot);
    }

    const expiresAt = now + HOLD_TTL_MS;
    const holdId = await ctx.db.insert("holds", {
      quoteId: quote._id,
      billboardId: quote.billboardId,
      slotIds: quote.slotIds,
      amountMinor: quote.amountMinor,
      currency: quote.currency,
      expiresAt,
      status: "active",
      idempotencyKey: args.idempotencyKey,
      actor: args.actor,
      traceId: quote.traceId,
    });

    for (const slot of slots) {
      await ctx.db.patch(slot._id, { state: "held", holdId });
    }

    await ctx.scheduler.runAt(expiresAt, internal.holds.expire, { holdId });

    await recordAudit(ctx, {
      traceId: quote.traceId,
      actor: args.actor,
      type: "slot.held",
      subjectId: holdId,
      reason: `Exclusive hold on ${slots.length} slot(s) until ${new Date(expiresAt).toISOString()}`,
      data: {
        quoteId: quote._id,
        slotIds: quote.slotIds,
        amountMinor: quote.amountMinor,
        expiresAt,
      },
    });

    const hold = await ctx.db.get(holdId);
    return toResult(hold!, false);
  },
});

/**
 * Return a hold's slots to inventory. Only slots still pointing at this hold
 * are reverted, so a stale call can never free someone else's inventory.
 */
async function endHold(
  ctx: MutationCtx,
  hold: Doc<"holds">,
  outcome: "released" | "expired",
  actor: string,
  reason: string,
): Promise<void> {
  await ctx.db.patch(hold._id, { status: outcome });

  const reverted: string[] = [];
  for (const slotId of hold.slotIds) {
    const slot = await ctx.db.get(slotId);
    if (slot && slot.state === "held" && slot.holdId === hold._id) {
      await ctx.db.patch(slotId, { state: "available", holdId: undefined });
      reverted.push(slotId);
    }
  }

  // If the underlying quote has also passed its expiry, close it now
  // (quotes.expire skipped it while this hold was active).
  const quote = await ctx.db.get(hold.quoteId);
  if (quote && quote.status === "open" && Date.now() >= quote.expiresAt) {
    await ctx.db.patch(quote._id, { status: "expired" });
    await recordAudit(ctx, {
      traceId: hold.traceId,
      actor: "system",
      type: "quote.expired",
      subjectId: quote._id,
      reason: "Quote expired after its hold ended without payment",
    });
  }

  await recordAudit(ctx, {
    traceId: hold.traceId,
    actor,
    type: outcome === "expired" ? "hold.expired" : "hold.released",
    subjectId: hold._id,
    reason,
    data: { quoteId: hold.quoteId, slotIds: reverted },
  });
  if (reverted.length > 0) {
    await recordAudit(ctx, {
      traceId: hold.traceId,
      actor,
      type: "slot.released",
      subjectId: hold._id,
      reason: `${reverted.length} slot(s) returned to available`,
      data: { slotIds: reverted },
    });
  }
}

/**
 * Buyer cancel. The caller proves it owns the hold by presenting the
 * idempotencyKey it created the hold with (there is no user auth yet).
 * Releasing a hold that is no longer active is a no-op.
 */
export const release = mutation({
  args: {
    holdId: v.id("holds"),
    idempotencyKey: v.string(),
    /** Defaults to "buyer". */
    actor: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  returns: v.object({ holdId: v.id("holds"), status: holdStatus }),
  handler: async (ctx, args) => {
    const actor = args.actor ?? "buyer";
    assertBoundedString("actor", actor, MAX_KEY_LENGTH);
    const hold = await ctx.db.get(args.holdId);
    if (!hold) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Hold not found" });
    }
    if (hold.idempotencyKey !== args.idempotencyKey) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Not the holder of this hold" });
    }
    if (hold.status !== "active") {
      return { holdId: hold._id, status: hold.status };
    }
    await endHold(
      ctx,
      hold,
      "released",
      actor,
      (args.reason ?? "Cancelled by holder").slice(0, 500),
    );
    return { holdId: hold._id, status: "released" as const };
  },
});

/**
 * Operator cancel. Internal until operator auth exists; invoke from the
 * dashboard (via a future authenticated wrapper) or `npx convex run`.
 */
export const operatorRelease = internalMutation({
  args: { holdId: v.id("holds"), reason: v.string() },
  returns: v.object({ holdId: v.id("holds"), status: holdStatus }),
  handler: async (ctx, args) => {
    const hold = await ctx.db.get(args.holdId);
    if (!hold) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Hold not found" });
    }
    if (hold.status !== "active") {
      return { holdId: hold._id, status: hold.status };
    }
    await endHold(ctx, hold, "released", "operator", args.reason.slice(0, 500));
    return { holdId: hold._id, status: "released" as const };
  },
});

/** Scheduled at hold expiry. No-op unless the hold is still active. */
export const expire = internalMutation({
  args: { holdId: v.id("holds") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const hold = await ctx.db.get(args.holdId);
    if (!hold || hold.status !== "active") return null;
    if (Date.now() < hold.expiresAt) {
      // Fired early (should not happen); try again at the real expiry.
      await ctx.scheduler.runAt(hold.expiresAt, internal.holds.expire, {
        holdId: hold._id,
      });
      return null;
    }
    await endHold(ctx, hold, "expired", "system", "Hold TTL elapsed without verified payment");
    return null;
  },
});

/**
 * What a payment server needs to issue payment requirements for a hold.
 * Internal: exposed only through the bearer-protected HTTP route.
 */
export const getForPayment = internalQuery({
  args: { holdId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      holdId: v.id("holds"),
      quoteId: v.id("quotes"),
      amountMinor: v.number(),
      currency,
      expiresAt: v.number(),
      status: holdStatus,
      payable: v.boolean(),
      /** Correlates server logs with the audit trail (quote -> hold -> payment -> booking). */
      traceId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const holdId = ctx.db.normalizeId("holds", args.holdId);
    if (!holdId) return null;
    const hold = await ctx.db.get(holdId);
    if (!hold) return null;
    return {
      holdId: hold._id,
      quoteId: hold.quoteId,
      amountMinor: hold.amountMinor,
      currency: hold.currency,
      expiresAt: hold.expiresAt,
      status: hold.status,
      payable: hold.status === "active" && Date.now() < hold.expiresAt,
      traceId: hold.traceId,
    };
  },
});
