/**
 * Open-web lead generation for the agency desk: draft outreach emails only.
 * Nothing is sent from BillboardOS — operators copy into their own mail client.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { recordAudit } from "./lib/audit";
import { draftAgencyOutreach, normalizeLeadInput } from "./lib/leadOutreach";
import { resolveWorkspace } from "./lib/tenancy";

const leadStatus = v.union(v.literal("draft"), v.literal("copied"), v.literal("dismissed"));

const leadRow = v.object({
  _id: v.id("agencyLeads"),
  companyName: v.string(),
  website: v.optional(v.string()),
  notes: v.optional(v.string()),
  subject: v.string(),
  body: v.string(),
  status: leadStatus,
  createdAt: v.number(),
  createdBy: v.string(),
});

/** Draft outreach for a company outside the seeded sponsor network. Never sends. */
export const draft = mutation({
  args: {
    companyName: v.string(),
    website: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: v.object({ leadId: v.id("agencyLeads"), subject: v.string(), body: v.string() }),
  handler: async (ctx, args) => {
    const member = await resolveWorkspace(ctx);
    const workspace = await ctx.db.get(member.workspaceId);
    const input = normalizeLeadInput({
      companyName: args.companyName,
      website: args.website,
      notes: args.notes,
      agencyName: workspace?.name ?? "BillboardOS Agency",
    });
    if ("error" in input) throw new ConvexError({ code: "INVALID_INPUT", message: input.error });
    const drafted = draftAgencyOutreach(input);
    if ("error" in drafted) throw new ConvexError({ code: "INVALID_INPUT", message: drafted.error });

    const leadId = await ctx.db.insert("agencyLeads", {
      workspaceId: member.workspaceId,
      companyName: input.companyName,
      website: input.website,
      notes: input.notes,
      subject: drafted.subject,
      body: drafted.body,
      status: "draft",
      createdAt: Date.now(),
      createdBy: member.actor,
    });

    await recordAudit(ctx, {
      traceId: `lead:${leadId}`,
      actor: member.actor,
      type: "lead.drafted",
      subjectId: leadId,
      workspaceId: member.workspaceId,
      reason: `Draft outreach for ${input.companyName} (not sent)`,
    });
    return { leadId, subject: drafted.subject, body: drafted.body };
  },
});

export const list = query({
  args: {},
  returns: v.array(leadRow),
  handler: async (ctx) => {
    const member = await resolveWorkspace(ctx);
    const rows = await ctx.db
      .query("agencyLeads")
      .withIndex("by_workspace_and_createdAt", (q) => q.eq("workspaceId", member.workspaceId))
      .order("desc")
      .take(40);
    return rows
      .filter((r) => r.status !== "dismissed")
      .map((r) => ({
        _id: r._id,
        companyName: r.companyName,
        website: r.website,
        notes: r.notes,
        subject: r.subject,
        body: r.body,
        status: r.status,
        createdAt: r.createdAt,
        createdBy: r.createdBy,
      }));
  },
});

/** Operator copied the draft into their own mail client — still never sent by us. */
export const markCopied = mutation({
  args: { leadId: v.id("agencyLeads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await resolveWorkspace(ctx);
    const lead = await ctx.db.get(args.leadId);
    if (!lead || lead.workspaceId !== member.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Lead not found" });
    }
    if (lead.status === "dismissed") {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Lead was dismissed" });
    }
    await ctx.db.patch(args.leadId, { status: "copied" });
    await recordAudit(ctx, {
      traceId: `lead:${args.leadId}`,
      actor: member.actor,
      type: "lead.copied",
      subjectId: args.leadId,
      workspaceId: member.workspaceId,
      reason: `Operator copied draft for ${lead.companyName} (still not sent by BillboardOS)`,
    });
    return null;
  },
});

export const dismiss = mutation({
  args: { leadId: v.id("agencyLeads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await resolveWorkspace(ctx);
    const lead = await ctx.db.get(args.leadId);
    if (!lead || lead.workspaceId !== member.workspaceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Lead not found" });
    }
    await ctx.db.patch(args.leadId, { status: "dismissed" });
    await recordAudit(ctx, {
      traceId: `lead:${args.leadId}`,
      actor: member.actor,
      type: "lead.dismissed",
      subjectId: args.leadId,
      workspaceId: member.workspaceId,
      reason: `Dismissed draft for ${lead.companyName}`,
    });
    return null;
  },
});
