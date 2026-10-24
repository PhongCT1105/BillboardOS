import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { addMomentStep } from "./lib/momentHooks";

/**
 * The live auction after a spot is announced: join window, then an auction,
 * a sale, a negotiation or no takers; award, pay deadline, queue release.
 * Stubs for now: Task 6 implements the lifecycle.
 */

/** End of the join window. Stub: records the step only (Task 6 decides auction, sale, negotiation or no takers). */
export const closeJoin = internalMutation({
  args: { momentId: v.id("moments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const moment = await ctx.db.get(args.momentId);
    if (!moment) return null;
    await addMomentStep(ctx, moment, "window_closed", "Join window closed");
    return null;
  },
});

/**
 * The host is free again: start the next queued screen's sale.
 * Stub: does nothing yet. Task 6 implements it (oldest `saleQueuedAt` among the
 * workspace's online screens, cleared, then `detectFor` with trigger "queue").
 */
export async function releaseWorkspace(_ctx: MutationCtx, _workspaceId: Id<"workspaces">): Promise<void> {}
