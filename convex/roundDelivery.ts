import { v } from "convex/values";
import { internalAction } from "./_generated/server";

export const roundEvent = v.union(v.literal("round_offer"), v.literal("round_won"), v.literal("round_lost"));

/** Signed webhook for one invited company (filled in by the agent-delivery task). */
export const deliver = internalAction({
  args: { bidId: v.id("roundBids"), event: roundEvent },
  returns: v.null(),
  handler: async () => null,
});
