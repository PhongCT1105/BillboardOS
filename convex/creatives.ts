import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { creativeStatus } from "./schema";
import { recordAudit } from "./lib/audit";
import { scheduleBooking } from "./lib/scheduling";

const MAX_CREATIVE_BYTES = 50 * 1024 * 1024;
const MAX_BOOKINGS_TO_SCHEDULE = 100;

/**
 * Step 1 of upload: returns a short-lived URL to POST the file to.
 * The POST response contains `{ storageId }`; pass it to `creatives.attach`.
 * TODO(auth): unauthenticated for the demo.
 */
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Step 2 of upload: attach an uploaded image/video to a campaign and send it
 * to operator review. Replaces (and deletes) a previous unapproved creative;
 * an approved creative is locked.
 */
export const attach = mutation({
  args: {
    campaignId: v.id("campaigns"),
    storageId: v.id("_storage"),
    contentType: v.string(),
  },
  returns: v.object({ campaignId: v.id("campaigns"), creativeStatus }),
  handler: async (ctx, args) => {
    if (
      args.contentType.length > 100 ||
      !/^(image|video)\/[\w.+-]+$/.test(args.contentType)
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "contentType must be image/* or video/*",
      });
    }
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found" });
    }
    if (campaign.creativeStatus === "approved") {
      throw new ConvexError({
        code: "CREATIVE_LOCKED",
        message: "Campaign already has an approved creative",
      });
    }
    const file = await ctx.db.system.get(args.storageId);
    if (!file) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Uploaded file not found" });
    }
    if (file.size > MAX_CREATIVE_BYTES) {
      await ctx.storage.delete(args.storageId);
      throw new ConvexError({ code: "INVALID_INPUT", message: "Creative exceeds 50 MB" });
    }

    const previous = campaign.creativeStorageId;
    if (previous && previous !== args.storageId) {
      await ctx.storage.delete(previous);
    }
    await ctx.db.patch(args.campaignId, {
      creativeStorageId: args.storageId,
      creativeContentType: args.contentType,
      creativeStatus: "pending_review",
      creativeSubmittedAt: Date.now(),
      creativeReviewReason: undefined,
    });
    await recordAudit(ctx, {
      traceId: `campaign:${args.campaignId}`,
      actor: "advertiser",
      type: "creative.attached",
      subjectId: args.campaignId,
      reason: `Creative (${args.contentType}, ${file.size} bytes) submitted for review`,
      data: { storageId: args.storageId, contentType: args.contentType, sha256: file.sha256 },
    });
    return { campaignId: args.campaignId, creativeStatus: "pending_review" as const };
  },
});

/**
 * Operator decision on a pending creative. Approving schedules every
 * not-yet-finished slot of the campaign's confirmed bookings.
 * TODO(auth): operator-only once auth exists.
 */
export const review = mutation({
  args: {
    campaignId: v.id("campaigns"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    reason: v.string(),
  },
  returns: v.object({
    campaignId: v.id("campaigns"),
    creativeStatus,
    slotsScheduled: v.number(),
  }),
  handler: async (ctx, args) => {
    const reason = args.reason.trim().slice(0, 500);
    if (reason.length === 0) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "reason is required" });
    }
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found" });
    }
    if (campaign.creativeStatus !== "pending_review" || !campaign.creativeStorageId) {
      throw new ConvexError({
        code: "NOT_PENDING",
        message: `Creative is ${campaign.creativeStatus ?? "none"}, not pending_review`,
      });
    }

    await ctx.db.patch(args.campaignId, {
      creativeStatus: args.decision,
      creativeReviewReason: reason,
    });
    await recordAudit(ctx, {
      traceId: `campaign:${args.campaignId}`,
      actor: "operator",
      type: args.decision === "approved" ? "creative.approved" : "creative.rejected",
      subjectId: args.campaignId,
      reason,
      data: { storageId: campaign.creativeStorageId },
    });

    let slotsScheduled = 0;
    if (args.decision === "approved") {
      const now = Date.now();
      const bookings = await ctx.db
        .query("bookings")
        .withIndex("by_campaign_and_status", (q) =>
          q.eq("campaignId", args.campaignId).eq("status", "confirmed"),
        )
        .take(MAX_BOOKINGS_TO_SCHEDULE);
      for (const booking of bookings) {
        slotsScheduled += await scheduleBooking(ctx, booking, now, "operator");
      }
    }
    return { campaignId: args.campaignId, creativeStatus: args.decision, slotsScheduled };
  },
});

/** Creatives awaiting operator review, oldest first (max 20), with a fresh file URL. */
export const pendingReview = query({
  args: {},
  returns: v.array(
    v.object({
      campaignId: v.id("campaigns"),
      advertiserName: v.string(),
      brief: v.string(),
      contentType: v.string(),
      creativeUrl: v.union(v.string(), v.null()),
      submittedAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_creativeStatus", (q) => q.eq("creativeStatus", "pending_review"))
      .take(20);
    const rows = [];
    for (const c of campaigns) {
      if (!c.creativeStorageId) continue;
      const advertiser = await ctx.db.get(c.advertiserId);
      rows.push({
        campaignId: c._id,
        advertiserName: advertiser?.displayName ?? "Unknown advertiser",
        brief: c.brief,
        contentType: c.creativeContentType ?? "application/octet-stream",
        creativeUrl: await ctx.storage.getUrl(c.creativeStorageId),
        submittedAt: c.creativeSubmittedAt ?? null,
      });
    }
    return rows;
  },
});
