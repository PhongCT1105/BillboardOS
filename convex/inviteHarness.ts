/**
 * Invite CREAO harness (background): when someone cools down or the active set
 * is thin, call BillboardOS Invite Rotate CREAO for prefer/demote weights.
 * Fast ranking stays Convex-owned; missing CREAO falls back to next-best vibe.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ACTIVE_INVITE_LIMIT, isCooled, rankMatch, rankTopInvites } from "./lib/inviteRoster";
import { matchScore } from "./lib/match";
import { researchOf } from "./research";
import { recordAudit } from "./lib/audit";
import { creaoRateLimiter } from "./creaoLimits";

const MAX_POOL = 80;
const MAX_PREFS = 20;

export const onRosterHole = internalMutation({
  args: { billboardId: v.id("billboards"), workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const limit = await creaoRateLimiter.limit(ctx, "creaoInviteThink", { throws: false });
    if (!limit.ok) {
      await ctx.db.insert("harnessRuns", {
        kind: "invite",
        billboardId: args.billboardId,
        workspaceId: args.workspaceId,
        status: "skipped",
        summary: `Invite harness rate-limited for ${limit.retryAfter}ms`,
        at: Date.now(),
      });
      return null;
    }
    await ctx.scheduler.runAfter(0, internal.inviteHarness.think, args);
    return null;
  },
});

export const rosterContext = internalQuery({
  args: { billboardId: v.id("billboards"), now: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      billboardName: v.string(),
      audienceTags: v.record(v.string(), v.number()),
      cooled: v.array(v.object({ advertiserId: v.id("advertisers"), name: v.string(), rejectStreak: v.number() })),
      ranked: v.array(
        v.object({
          advertiserId: v.id("advertisers"),
          name: v.string(),
          match: v.union(v.number(), v.null()),
        }),
      ),
    }),
  ),
  handler: async (ctx, { billboardId, now }) => {
    const billboard = await ctx.db.get(billboardId);
    if (!billboard) return null;
    const agents = await ctx.db.query("companyAgents").take(MAX_POOL);
    const cooledRows = await ctx.db
      .query("inviteStats")
      .withIndex("by_billboard", (q) => q.eq("billboardId", billboardId))
      .take(MAX_POOL);
    const cooled = [];
    for (const s of cooledRows) {
      if (!isCooled(s, now)) continue;
      const a = await ctx.db.get(s.advertiserId);
      cooled.push({ advertiserId: s.advertiserId, name: a?.displayName ?? "Company", rejectStreak: s.rejectStreak });
    }
    const candidates = [];
    for (const agent of agents) {
      if (!agent.enabled) continue;
      if (isCooled(cooledRows.find((s) => s.advertiserId === agent.advertiserId), now)) continue;
      const advertiser = await ctx.db.get(agent.advertiserId);
      const research = await researchOf(ctx, agent.advertiserId);
      const campaign = await ctx.db.get(agent.campaignId);
      const match = matchScore(billboard.audienceTags, research?.audienceTags ?? campaign?.targetAudience);
      candidates.push({
        advertiserId: agent.advertiserId,
        name: advertiser?.displayName ?? "Company",
        match,
      });
    }
    const ranked = rankTopInvites(candidates, ACTIVE_INVITE_LIMIT + 5).map((c) => ({
      advertiserId: c.advertiserId,
      name: c.name,
      match: c.match,
    }));
    return {
      billboardName: billboard.name,
      audienceTags: billboard.audienceTags ?? {},
      cooled,
      ranked,
    };
  },
});

export const applyPrefs = internalMutation({
  args: {
    billboardId: v.id("billboards"),
    workspaceId: v.id("workspaces"),
    prefs: v.array(v.object({ advertiserId: v.id("advertisers"), weight: v.number(), reason: v.string() })),
    summary: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const p of args.prefs.slice(0, MAX_PREFS)) {
      if (!Number.isFinite(p.weight) || p.weight < -10 || p.weight > 10) continue;
      const existing = await ctx.db
        .query("billboardInvitePrefs")
        .withIndex("by_billboard_and_advertiser", (q) =>
          q.eq("billboardId", args.billboardId).eq("advertiserId", p.advertiserId),
        )
        .first();
      if (existing) await ctx.db.patch(existing._id, { weight: p.weight, reason: p.reason.slice(0, 200), updatedAt: now });
      else {
        await ctx.db.insert("billboardInvitePrefs", {
          billboardId: args.billboardId,
          advertiserId: p.advertiserId,
          weight: p.weight,
          reason: p.reason.slice(0, 200),
          updatedAt: now,
        });
      }
    }
    await ctx.db.insert("harnessRuns", {
      kind: "invite",
      billboardId: args.billboardId,
      workspaceId: args.workspaceId,
      status: "ok",
      summary: args.summary.slice(0, 400),
      at: now,
    });
    await recordAudit(ctx, {
      traceId: `harness:invite:${args.billboardId}`,
      actor: "invite-harness",
      type: "invite.prefs_updated",
      subjectId: args.billboardId,
      reason: args.summary.slice(0, 400),
    });
    return null;
  },
});

export const recordSkip = internalMutation({
  args: {
    billboardId: v.id("billboards"),
    workspaceId: v.id("workspaces"),
    summary: v.string(),
    status: v.union(v.literal("skipped"), v.literal("failed")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("harnessRuns", {
      kind: "invite",
      billboardId: args.billboardId,
      workspaceId: args.workspaceId,
      status: args.status,
      summary: args.summary.slice(0, 400),
      at: Date.now(),
    });
    return null;
  },
});

/**
 * Background think: call Invite Rotate CREAO when configured; otherwise
 * write deterministic prefs that boost the next-best ranked companies.
 */
export const think = internalAction({
  args: { billboardId: v.id("billboards"), workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const snap = await ctx.runQuery(internal.inviteHarness.rosterContext, { billboardId: args.billboardId, now });
    if (!snap) {
      await ctx.runMutation(internal.inviteHarness.recordSkip, {
        ...args,
        status: "skipped",
        summary: "Billboard missing",
      });
      return null;
    }

    const traceId = `invite:${args.billboardId}:${now}`;
    const request = {
      schemaVersion: 1,
      role: "invite_rotate",
      traceId,
      billboard: snap.billboardName,
      audienceTags: snap.audienceTags,
      cooled: snap.cooled,
      ranked: snap.ranked,
    };

    let prefs: Array<{ advertiserId: Id<"advertisers">; weight: number; reason: string }> = [];
    let summary = "";

    try {
      const result = await ctx.runAction(internal.creaoLive.run, {
        role: "invite_rotate",
        requestJson: JSON.stringify(request),
      });
      if (
        result &&
        typeof result === "object" &&
        result.status === "rotated" &&
        Array.isArray((result as { prefs?: unknown }).prefs)
      ) {
        for (const raw of (result as { prefs: unknown[] }).prefs) {
          if (!raw || typeof raw !== "object") continue;
          const p = raw as { advertiserId?: unknown; weight?: unknown; reason?: unknown };
          if (typeof p.advertiserId !== "string" || typeof p.weight !== "number") continue;
          const known =
            snap.ranked.find((r: { advertiserId: Id<"advertisers"> }) => r.advertiserId === p.advertiserId) ??
            snap.cooled.find((c: { advertiserId: Id<"advertisers"> }) => c.advertiserId === p.advertiserId);
          if (!known) continue;
          prefs.push({
            advertiserId: p.advertiserId as Id<"advertisers">,
            weight: p.weight,
            reason: typeof p.reason === "string" ? p.reason : "Invite Rotate preference",
          });
        }
        summary = `Invite Rotate CREAO returned ${prefs.length} preference(s) for ${snap.billboardName}`;
      } else {
        const extras = snap.ranked.slice(ACTIVE_INVITE_LIMIT);
        prefs = extras.slice(0, 5).map((c: (typeof snap.ranked)[number], i: number) => ({
          advertiserId: c.advertiserId,
          weight: 3 - i * 0.5,
          reason: `Next-best vibe match ${Math.round(rankMatch(c.match) * 100)}% (Invite Rotate unset)`,
        }));
        summary =
          result === null
            ? `Invite Rotate CREAO unset; boosted ${prefs.length} next-best for ${snap.billboardName}`
            : `Invite Rotate returned no prefs; boosted ${prefs.length} next-best for ${snap.billboardName}`;
      }
    } catch (error) {
      const extras = snap.ranked.slice(0, ACTIVE_INVITE_LIMIT);
      prefs = extras.map((c: (typeof snap.ranked)[number], i: number) => ({
        advertiserId: c.advertiserId,
        weight: Math.max(0, 2 - i * 0.2),
        reason: "Fallback reaffirm after Invite Rotate error",
      }));
      summary = `Invite Rotate failed (${error instanceof Error ? error.message.slice(0, 120) : "error"}); kept Convex ranking for ${snap.billboardName}`;
      await ctx.runMutation(internal.inviteHarness.applyPrefs, {
        billboardId: args.billboardId,
        workspaceId: args.workspaceId,
        prefs,
        summary,
      });
      return null;
    }

    await ctx.runMutation(internal.inviteHarness.applyPrefs, {
      billboardId: args.billboardId,
      workspaceId: args.workspaceId,
      prefs,
      summary,
    });
    return null;
  },
});
