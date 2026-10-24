import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { creativeStatus } from "./schema";
import { recordAudit } from "./lib/audit";
import { scheduleBooking } from "./lib/scheduling";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireCampaignAccess, requireCustomer, resolveWorkspace } from "./lib/tenancy";
import {
  YOUTUBE_CONTENT_TYPE,
  defaultThumbnailUrl,
  hasCreative,
  oembedUrl,
  parseOEmbed,
  parseYouTubeUrl,
} from "./lib/youtube";
import {
  recordHostDecision,
  resetCreativeReviews,
  reviewLabel,
  scheduleCreativeReview,
  youtubeOf,
} from "./creativeReview";
import { requestKnowledgeBuild } from "./knowledge";

/** A host may review a campaign's creative once that campaign has quoted one of its screens. */
async function campaignTouchesWorkspace(ctx: QueryCtx, campaignId: Id<"campaigns">, workspaceId: Id<"workspaces">) {
  const quotes = await ctx.db
    .query("quotes")
    .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
    .take(100);
  return quotes.some((q) => q.workspaceId === workspaceId);
}

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
    await requireCustomer(ctx);
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
    const { campaign, customer } = await requireCampaignAccess(ctx, args.campaignId);
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
    // A file replaces a YouTube link.
    const youtube = await youtubeOf(ctx, args.campaignId);
    if (youtube) await ctx.db.delete(youtube._id);
    // A new creative is reviewed from scratch on every host's screens.
    await resetCreativeReviews(ctx, args.campaignId);
    await ctx.db.patch(args.campaignId, {
      creativeStorageId: args.storageId,
      creativeContentType: args.contentType,
      creativeStatus: "pending_review",
      creativeSubmittedAt: Date.now(),
      creativeReviewReason: undefined,
    });
    await recordAudit(ctx, {
      traceId: `campaign:${args.campaignId}`,
      actor: customer.actor,
      type: "creative.attached",
      subjectId: args.campaignId,
      reason: `Creative (${args.contentType}, ${file.size} bytes) submitted for review`,
      data: { storageId: args.storageId, contentType: args.contentType, sha256: file.sha256 },
    });
    // AI-native approvals: the creative review agent checks it for every host; the knowledge card learns from it.
    await scheduleCreativeReview(ctx, args.campaignId);
    await requestKnowledgeBuild(ctx, campaign.advertiserId, "creative attached");
    return { campaignId: args.campaignId, creativeStatus: "pending_review" as const };
  },
});

const OEMBED_TIMEOUT_MS = 5_000;

/**
 * Attach a YouTube link as the campaign's creative (ADR 0007): stored as the
 * video id and canonical URL, never downloaded. Same review as uploads.
 * Replaces (and deletes) a previous unapproved creative; an approved one is
 * locked. Public title, channel and thumbnail are fetched in the background.
 */
export const attachYouTube = mutation({
  args: { campaignId: v.id("campaigns"), url: v.string() },
  returns: v.object({ campaignId: v.id("campaigns"), creativeStatus, videoId: v.string() }),
  handler: async (ctx, args) => {
    const parsed = parseYouTubeUrl(args.url);
    if (!parsed.ok) throw new ConvexError({ code: "INVALID_INPUT", message: parsed.error });
    const { campaign, customer } = await requireCampaignAccess(ctx, args.campaignId);
    if (campaign.creativeStatus === "approved") {
      throw new ConvexError({ code: "CREATIVE_LOCKED", message: "Campaign already has an approved creative" });
    }
    if (campaign.creativeStorageId) await ctx.storage.delete(campaign.creativeStorageId);
    const now = Date.now();
    const existing = await youtubeOf(ctx, args.campaignId);
    const row = {
      campaignId: campaign._id,
      advertiserId: campaign.advertiserId,
      videoId: parsed.videoId,
      url: parsed.url,
      thumbnailUrl: defaultThumbnailUrl(parsed.videoId),
      oembedStatus: "pending" as const,
      attachedAt: now,
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("youtubeCreatives", row);
    await resetCreativeReviews(ctx, args.campaignId);
    await ctx.db.patch(args.campaignId, {
      creativeStorageId: undefined,
      creativeContentType: YOUTUBE_CONTENT_TYPE,
      creativeStatus: "pending_review",
      creativeSubmittedAt: now,
      creativeReviewReason: undefined,
    });
    await recordAudit(ctx, {
      traceId: `campaign:${args.campaignId}`,
      actor: customer.actor,
      type: "creative.attached",
      subjectId: args.campaignId,
      reason: `YouTube creative ${parsed.url} submitted for review`,
      data: { provider: "youtube", videoId: parsed.videoId, url: parsed.url },
    });
    // Title and channel first; the review and the knowledge card follow once they are in.
    await ctx.scheduler.runAfter(0, internal.creatives.fetchYouTubeDetails, { campaignId: args.campaignId, videoId: parsed.videoId });
    return { campaignId: args.campaignId, creativeStatus: "pending_review" as const, videoId: parsed.videoId };
  },
});

/** Public oEmbed lookup (title, channel, thumbnail), 5 s timeout, validated. Never fails the creative. */
export const fetchYouTubeDetails = internalAction({
  args: { campaignId: v.id("campaigns"), videoId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let details: ReturnType<typeof parseOEmbed> = null;
    let error: string | undefined;
    // One retry for network errors and timeouts (a cold first connection can be slow); HTTP answers are final.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(oembedUrl(args.videoId), {
          signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          error = res.status === 401 || res.status === 403 ? "embedding is disabled for this video" : res.status === 404 ? "video not found or private" : `oEmbed HTTP ${res.status}`;
        } else {
          details = parseOEmbed(await res.json());
          error = details ? undefined : "oEmbed returned an unexpected shape";
        }
        break;
      } catch (e) {
        error = `oEmbed failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (error) console.warn(`YouTube oEmbed for ${args.videoId}: ${error}`);
    else console.log(`YouTube oEmbed for ${args.videoId}: "${details?.title}" by ${details?.author}`);
    await ctx.runMutation(internal.creatives.saveYouTubeDetails, {
      campaignId: args.campaignId,
      videoId: args.videoId,
      details: details ?? undefined,
      error: error?.slice(0, 200),
    });
    return null;
  },
});

export const saveYouTubeDetails = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    videoId: v.string(),
    details: v.optional(
      v.object({ title: v.string(), author: v.string(), authorUrl: v.union(v.string(), v.null()), thumbnailUrl: v.string() }),
    ),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await youtubeOf(ctx, args.campaignId);
    // A newer link replaced this one: drop the stale lookup.
    if (!row || row.videoId !== args.videoId) return null;
    const now = Date.now();
    if (args.details) {
      await ctx.db.patch(row._id, {
        title: args.details.title,
        author: args.details.author,
        authorUrl: args.details.authorUrl ?? undefined,
        thumbnailUrl: args.details.thumbnailUrl,
        oembedStatus: "ok",
        oembedError: undefined,
        fetchedAt: now,
      });
    } else {
      await ctx.db.patch(row._id, { oembedStatus: "failed", oembedError: args.error ?? "unknown error", fetchedAt: now });
    }
    await scheduleCreativeReview(ctx, args.campaignId);
    await requestKnowledgeBuild(ctx, row.advertiserId, "YouTube creative attached");
    return null;
  },
});

/** Preview fields for a campaign's creative: a fresh file URL, or the YouTube thumbnail. */
async function creativePreview(ctx: QueryCtx, c: Doc<"campaigns">) {
  if (c.creativeContentType === YOUTUBE_CONTENT_TYPE) {
    const yt = await youtubeOf(ctx, c._id);
    if (!yt) return null;
    return { creativeUrl: yt.thumbnailUrl, contentType: YOUTUBE_CONTENT_TYPE, youtubeVideoId: yt.videoId, creativeTitle: yt.title };
  }
  if (!c.creativeStorageId) return null;
  return {
    creativeUrl: await ctx.storage.getUrl(c.creativeStorageId),
    contentType: c.creativeContentType ?? "application/octet-stream",
    youtubeVideoId: undefined,
    creativeTitle: undefined,
  };
}

/** The review agent's line for this host, e.g. "Approved by creative review agent: ...". */
async function agentNoteFor(ctx: QueryCtx, campaignId: Id<"campaigns">, workspaceId: Id<"workspaces">) {
  const r = await ctx.db
    .query("creativeReviews")
    .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", workspaceId).eq("campaignId", campaignId))
    .unique();
  return r && r.verdict !== "skipped" ? reviewLabel(r.verdict, r.reason) : undefined;
}

/**
 * Operator decision on a pending creative. Approving schedules every
 * not-yet-finished slot of the campaign's confirmed bookings.
 * Operator only.
 */
export const review = mutation({
  args: {
    campaignId: v.id("campaigns"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    reason: v.string(),
    workspaceId: v.optional(v.id("workspaces")),
  },
  returns: v.object({
    campaignId: v.id("campaigns"),
    creativeStatus,
    slotsScheduled: v.number(),
  }),
  handler: async (ctx, args) => {
    const operator = await resolveWorkspace(ctx, args.workspaceId);
    if (!(await campaignTouchesWorkspace(ctx, args.campaignId, operator.workspaceId))) {
      throw new ConvexError({
        code: "NOT_WORKSPACE_MEMBER",
        message: "This campaign hasn't quoted any of your workspace's screens",
      });
    }
    const reason = args.reason.trim().slice(0, 500);
    if (reason.length === 0) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "reason is required" });
    }
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Campaign not found" });
    }
    if (campaign.creativeStatus !== "pending_review" || !hasCreative(campaign)) {
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
      workspaceId: operator.workspaceId,
      traceId: `campaign:${args.campaignId}`,
      actor: operator.actor,
      type: args.decision === "approved" ? "creative.approved" : "creative.rejected",
      subjectId: args.campaignId,
      reason,
      data: { storageId: campaign.creativeStorageId ?? null, contentType: campaign.creativeContentType ?? null },
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
        // Approval schedules this workspace's bookings only.
        if (booking.workspaceId !== operator.workspaceId) continue;
        slotsScheduled += await scheduleBooking(ctx, booking, now, operator.actor);
      }
    }
    return { campaignId: args.campaignId, creativeStatus: args.decision, slotsScheduled };
  },
});

/** Creatives awaiting operator review, oldest first (max 20), with a fresh file URL. */
export const pendingReview = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(
    v.object({
      campaignId: v.id("campaigns"),
      advertiserName: v.string(),
      brief: v.string(),
      contentType: v.string(),
      creativeUrl: v.union(v.string(), v.null()),
      submittedAt: v.union(v.number(), v.null()),
      /** YouTube creatives: creativeUrl is the thumbnail; contentType is "youtube". */
      youtubeVideoId: v.optional(v.string()),
      creativeTitle: v.optional(v.string()),
      /** What the creative review agent decided for this workspace, ready to show. */
      agentNote: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const campaigns = await ctx.db
      .query("campaigns")
      .withIndex("by_creativeStatus", (q) => q.eq("creativeStatus", "pending_review"))
      .take(20);
    const rows = [];
    for (const c of campaigns) {
      if (!hasCreative(c)) continue;
      if (!(await campaignTouchesWorkspace(ctx, c._id, me.workspaceId))) continue;
      const preview = await creativePreview(ctx, c);
      if (!preview) continue;
      const advertiser = await ctx.db.get(c.advertiserId);
      rows.push({
        campaignId: c._id,
        advertiserName: advertiser?.displayName ?? "Unknown advertiser",
        brief: c.brief,
        contentType: preview.contentType,
        creativeUrl: preview.creativeUrl,
        submittedAt: c.creativeSubmittedAt ?? null,
        youtubeVideoId: preview.youtubeVideoId,
        creativeTitle: preview.creativeTitle,
        agentNote: await agentNoteFor(ctx, c._id, me.workspaceId),
      });
    }
    return rows;
  },
});

// ---------------------------------------------------------------------------
// Ready creatives (ADR 0006): a host approves a campaign's creative for its
// screens once; it can then play the moment a flash spot is paid, and the
// player preloads it.
// ---------------------------------------------------------------------------

/** Creatives a host can make ready: approved ones, and pending ones that quoted this host. */
export const readyForWorkspace = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.array(
    v.object({
      campaignId: v.id("campaigns"),
      advertiserName: v.string(),
      brief: v.string(),
      contentType: v.string(),
      creativeUrl: v.union(v.string(), v.null()),
      ready: v.boolean(),
      approvedBy: v.union(v.string(), v.null()),
      /** YouTube creatives: creativeUrl is the thumbnail; contentType is "youtube". */
      youtubeVideoId: v.optional(v.string()),
      creativeTitle: v.optional(v.string()),
      /** What the creative review agent decided for this workspace, ready to show. */
      agentNote: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const approved = await ctx.db
      .query("campaigns")
      .withIndex("by_creativeStatus", (q) => q.eq("creativeStatus", "approved"))
      .take(50);
    const pending = await ctx.db
      .query("campaigns")
      .withIndex("by_creativeStatus", (q) => q.eq("creativeStatus", "pending_review"))
      .take(20);
    const rows = [];
    for (const c of [...approved, ...pending]) {
      if (!hasCreative(c) || c.status !== "active") continue;
      const approval = await ctx.db
        .query("creativeApprovals")
        .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", me.workspaceId).eq("campaignId", c._id))
        .first();
      const agentNote = await agentNoteFor(ctx, c._id, me.workspaceId);
      // Pending creatives show up once they quoted this host, or the review agent looked at them for it.
      if (
        c.creativeStatus === "pending_review" &&
        !approval &&
        agentNote === undefined &&
        !(await campaignTouchesWorkspace(ctx, c._id, me.workspaceId))
      ) {
        continue;
      }
      const preview = await creativePreview(ctx, c);
      if (!preview) continue;
      rows.push({
        campaignId: c._id,
        advertiserName: (await ctx.db.get(c.advertiserId))?.displayName ?? "Unknown advertiser",
        brief: c.brief,
        contentType: preview.contentType,
        creativeUrl: preview.creativeUrl,
        ready: approval !== null,
        approvedBy: approval?.approvedBy ?? null,
        youtubeVideoId: preview.youtubeVideoId,
        creativeTitle: preview.creativeTitle,
        agentNote,
      });
    }
    return rows;
  },
});

/** Host member: make (or stop making) a campaign's creative ready on this workspace's screens. */
export const setReady = mutation({
  args: { campaignId: v.id("campaigns"), ready: v.boolean(), workspaceId: v.optional(v.id("workspaces")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign || !hasCreative(campaign)) throw new ConvexError({ code: "NOT_FOUND", message: "Campaign has no creative" });
    const existing = await ctx.db
      .query("creativeApprovals")
      .withIndex("by_workspace_and_campaign", (q) => q.eq("workspaceId", me.workspaceId).eq("campaignId", campaign._id))
      .first();
    if (args.ready && !existing) {
      await ctx.db.insert("creativeApprovals", { campaignId: campaign._id, workspaceId: me.workspaceId, approvedBy: me.actor, approvedAt: Date.now() });
    } else if (!args.ready && existing) {
      await ctx.db.delete(existing._id);
    } else {
      return null;
    }
    // The host overrides the review agent: it won't change this workspace's decision for this creative.
    await recordHostDecision(ctx, campaign, me.workspaceId, args.ready, me.actor);
    await recordAudit(ctx, {
      workspaceId: me.workspaceId,
      traceId: `campaign:${campaign._id}`,
      actor: me.actor,
      type: "creative.ready",
      subjectId: campaign._id,
      reason: args.ready ? "Creative approved as ready to play on this host's screens" : "Creative no longer ready on this host's screens",
    });
    return null;
  },
});
