import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { audienceTags, eventFields, eventSource } from "./schema";
import { scheduleDetect } from "./moments";
import { recordAudit } from "./lib/audit";
import { EVENT_UPLIFT_MAX } from "./lib/stages";
import { validateTags } from "./lib/match";
import { requireWorkspaceMember, workspaceOfBillboard } from "./lib/tenancy";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Upsert an event near a screen (keyed by billboard + name + start time).
 * Uplift is clamped to x1.0..x1.5 and confidence to 0..1 here AND again in
 * the event stage. Hook: a Claude "pricing analyst" action can later call this
 * with source "claude" after classifying an event's audience and size.
 */
export async function upsertEvent(
  ctx: MutationCtx,
  input: {
    billboardId: Id<"billboards">;
    name: string;
    startsAt: number;
    endsAt: number;
    expectedAttendance?: number;
    audienceTags?: Record<string, number>;
    upliftMultiplier: number;
    confidence: number;
    source: "seed" | "operator" | "claude" | "host";
    explanation: string;
  },
  actor: string,
): Promise<{ eventId: Id<"events">; created: boolean }> {
  const name = input.name.trim().slice(0, 120);
  if (name.length === 0) throw new ConvexError({ code: "INVALID_INPUT", message: "Event name required" });
  if (!(input.endsAt > input.startsAt) || input.endsAt - input.startsAt > DAY_MS) {
    throw new ConvexError({ code: "INVALID_INPUT", message: "Event must end after it starts and last at most 24h" });
  }
  if (input.audienceTags) {
    const problem = validateTags(input.audienceTags);
    if (problem) throw new ConvexError({ code: "INVALID_INPUT", message: problem });
  }
  const billboard = await ctx.db.get(input.billboardId);
  const fields = {
    ...input,
    workspaceId: billboard?.workspaceId,
    name,
    upliftMultiplier: Math.min(EVENT_UPLIFT_MAX, Math.max(1, input.upliftMultiplier)),
    confidence: Math.min(1, Math.max(0, input.confidence)),
    explanation: input.explanation.slice(0, 500),
  };
  const existing = await ctx.db
    .query("events")
    .withIndex("by_billboard_and_startsAt", (q) => q.eq("billboardId", input.billboardId).eq("startsAt", input.startsAt))
    .take(10);
  const same = existing.find((e) => e.name === name);
  // A live event changes who is in front of the screen: let the moment detector re-check (ADR 0006).
  const now = Date.now();
  if (input.startsAt <= now && input.endsAt > now) await scheduleDetect(ctx, input.billboardId, "event");
  if (same) {
    await ctx.db.replace(same._id, fields);
    return { eventId: same._id, created: false };
  }
  const eventId = await ctx.db.insert("events", fields);
  await recordAudit(ctx, {
    workspaceId: billboard?.workspaceId,
    traceId: `billboard:${input.billboardId}`,
    actor,
    type: "event.recorded",
    subjectId: eventId,
    reason: `${name}: uplift x${fields.upliftMultiplier.toFixed(2)} (${input.source}). ${fields.explanation}`.slice(0, 1000),
  });
  return { eventId, created: true };
}

/** Internal entry point for seeds and (later) the Claude event interpreter. */
export const record = internalMutation({
  args: {
    billboardId: v.id("billboards"),
    name: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    expectedAttendance: v.optional(v.number()),
    audienceTags: v.optional(audienceTags),
    upliftMultiplier: v.number(),
    confidence: v.number(),
    source: eventSource,
    explanation: v.string(),
  },
  returns: v.object({ eventId: v.id("events"), created: v.boolean() }),
  handler: async (ctx, args) => upsertEvent(ctx, args, `system:${args.source}`),
});

/** Host: enter the real event happening at the venue. Workspace members only. */
export const create = mutation({
  args: {
    billboardId: v.id("billboards"),
    name: v.string(),
    startsAt: v.number(),
    endsAt: v.number(),
    audienceTags: v.optional(audienceTags),
  },
  returns: v.object({ eventId: v.id("events") }),
  handler: async (ctx, args) => {
    const member = await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
    const { eventId } = await upsertEvent(
      ctx,
      {
        ...args,
        upliftMultiplier: 1,
        confidence: 1,
        source: "host",
        explanation: "Entered by the host: the real event at the venue.",
      },
      member.actor,
    );
    return { eventId };
  },
});

/** Events near a screen from 24h ago to 3 days ahead (max 20). Public. */
export const forBillboard = query({
  args: { billboardId: v.id("billboards") },
  returns: v.array(v.object({ _id: v.id("events"), _creationTime: v.number(), ...eventFields })),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db
      .query("events")
      .withIndex("by_billboard_and_startsAt", (q) =>
        q.eq("billboardId", args.billboardId).gte("startsAt", now - DAY_MS).lte("startsAt", now + 3 * DAY_MS),
      )
      .take(20);
  },
});
