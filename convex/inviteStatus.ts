/**
 * Operator view: which companies are in the active top-10 vibe set, who is
 * cooled down, and the last Price / Invite harness runs for a billboard.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import { ACTIVE_INVITE_LIMIT, isCooled, rankTopInvites } from "./lib/inviteRoster";
import { matchScore } from "./lib/match";
import { researchOf } from "./research";
import { campaignsReadyFor } from "./lib/sale";
import { resolveWorkspace, requireWorkspaceMember } from "./lib/tenancy";

const MAX_SCAN = 100;

export const forBillboard = query({
  args: { billboardId: v.id("billboards") },
  returns: v.object({
    active: v.array(
      v.object({
        advertiserId: v.id("advertisers"),
        name: v.string(),
        match: v.union(v.number(), v.null()),
        prefWeight: v.number(),
      }),
    ),
    cooled: v.array(
      v.object({
        advertiserId: v.id("advertisers"),
        name: v.string(),
        rejectStreak: v.number(),
        cooledUntilAt: v.number(),
      }),
    ),
    lastPriceHarness: v.union(
      v.null(),
      v.object({ status: v.string(), summary: v.string(), at: v.number() }),
    ),
    lastInviteHarness: v.union(
      v.null(),
      v.object({ status: v.string(), summary: v.string(), at: v.number() }),
    ),
    networkSize: v.number(),
    inviteLimit: v.number(),
  }),
  handler: async (ctx, args) => {
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard?.workspaceId) {
      return {
        active: [],
        cooled: [],
        lastPriceHarness: null,
        lastInviteHarness: null,
        networkSize: 0,
        inviteLimit: ACTIVE_INVITE_LIMIT,
      };
    }
    await requireWorkspaceMember(ctx, billboard.workspaceId);
    const now = Date.now();

    const ready = await campaignsReadyFor(ctx, billboard.workspaceId);
    const byAdv = new Map<string, (typeof ready)[number]>();
    for (const c of ready) if (!byAdv.has(c.advertiserId)) byAdv.set(c.advertiserId, c);

    const prefs = await ctx.db
      .query("billboardInvitePrefs")
      .withIndex("by_billboard", (q) => q.eq("billboardId", args.billboardId))
      .take(MAX_SCAN);
    const prefBy = new Map(prefs.map((p) => [p.advertiserId, p.weight]));

    const stats = await ctx.db
      .query("inviteStats")
      .withIndex("by_billboard", (q) => q.eq("billboardId", args.billboardId))
      .take(MAX_SCAN);

    const cooled = [];
    for (const s of stats) {
      if (!isCooled(s, now) || s.cooledUntilAt === undefined) continue;
      const a = await ctx.db.get(s.advertiserId);
      cooled.push({
        advertiserId: s.advertiserId,
        name: a?.displayName ?? "Company",
        rejectStreak: s.rejectStreak,
        cooledUntilAt: s.cooledUntilAt,
      });
    }

    const candidates = [];
    for (const [advertiserId, campaign] of byAdv) {
      const id = advertiserId as typeof campaign.advertiserId;
      if (isCooled(stats.find((s) => s.advertiserId === id), now)) continue;
      const research = await researchOf(ctx, id);
      const advertiser = await ctx.db.get(id);
      candidates.push({
        advertiserId: id,
        name: advertiser?.displayName ?? "Company",
        match: matchScore(billboard.audienceTags, research?.audienceTags ?? campaign.targetAudience),
        prefWeight: prefBy.get(id) ?? 0,
      });
    }
    const active = rankTopInvites(candidates, ACTIVE_INVITE_LIMIT);

    const priceRuns = await ctx.db.query("harnessRuns").withIndex("by_kind_and_at", (q) => q.eq("kind", "price")).order("desc").take(1);
    const inviteRuns = await ctx.db
      .query("harnessRuns")
      .withIndex("by_billboard_and_kind", (q) => q.eq("billboardId", args.billboardId).eq("kind", "invite"))
      .order("desc")
      .take(5);
    // harnessRuns index is by_billboard_and_kind without at — filter newest invite for this board
    const lastInvite = inviteRuns.sort((a, b) => b.at - a.at)[0] ?? null;
    const lastPrice = priceRuns[0] ?? null;

    return {
      active: active.map((a) => ({
        advertiserId: a.advertiserId,
        name: a.name,
        match: a.match,
        prefWeight: a.prefWeight,
      })),
      cooled,
      lastPriceHarness: lastPrice ? { status: lastPrice.status, summary: lastPrice.summary, at: lastPrice.at } : null,
      lastInviteHarness: lastInvite ? { status: lastInvite.status, summary: lastInvite.summary, at: lastInvite.at } : null,
      networkSize: byAdv.size,
      inviteLimit: ACTIVE_INVITE_LIMIT,
    };
  },
});

/** Workspace-wide harness pulse for the console strip. */
export const harnessPulse = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({
    lastPrice: v.union(v.null(), v.object({ status: v.string(), summary: v.string(), at: v.number() })),
    lastInvite: v.union(v.null(), v.object({ status: v.string(), summary: v.string(), at: v.number() })),
  }),
  handler: async (ctx, args) => {
    await resolveWorkspace(ctx, args.workspaceId);
    const price = await ctx.db.query("harnessRuns").withIndex("by_kind_and_at", (q) => q.eq("kind", "price")).order("desc").first();
    const invite = await ctx.db.query("harnessRuns").withIndex("by_kind_and_at", (q) => q.eq("kind", "invite")).order("desc").first();
    return {
      lastPrice: price ? { status: price.status, summary: price.summary, at: price.at } : null,
      lastInvite: invite ? { status: invite.status, summary: invite.summary, at: invite.at } : null,
    };
  },
});
