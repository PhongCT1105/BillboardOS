import type { Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { auditData, auditEventType } from "../schema";

export type AuditEventType = Infer<typeof auditEventType>;
export type AuditData = Infer<typeof auditData>;

/** Append one audit event. Every state-changing mutation calls this (P0-10). */
export async function recordAudit(
  ctx: MutationCtx,
  event: {
    /** Host workspace the event belongs to (omitted for platform-level events). */
    workspaceId?: Id<"workspaces">;
    traceId: string;
    actor: string;
    type: AuditEventType;
    subjectId: string;
    reason: string;
    data?: AuditData;
  },
): Promise<Id<"auditEvents">> {
  return await ctx.db.insert("auditEvents", event);
}
