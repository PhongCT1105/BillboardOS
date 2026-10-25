import { ConvexError, v, type Infer } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { deviceFor } from "./devices";
import { liveBox } from "./schemaParts/liveAudience";
import { requireCustomer, requireUser, requireWorkspaceMember, resolveWorkspace, workspaceOfBillboard } from "./lib/tenancy";

/**
 * Live audience. The camera image never leaves the screen; only boxes and counts do.
 *   - Live view: the screen's host, or the company whose paid ad is on air, opens a
 *     pop-up. While it is open (`watch`, renewed every 10 s) the screen sends its
 *     people boxes a few times a second (`pushFrame`) and the pop-up draws them (`view`).
 *   - Window report: when a 30-second window ends, the screen sends what its camera
 *     saw (`reportWindow`): unique people, average time in view, who faced the screen
 *     and for how long. The host sees every window; the payer sees its own.
 */

/** A live view request lasts this long; the pop-up renews it every 10 s. */
const REQUEST_MS = 20_000;
const MAX_BOXES = 20;
const MAX_PEOPLE = 1_000;
/** Device clocks drift: a report may arrive a little before the window's end. */
const REPORT_EARLY_MS = 3_000;
/** A report this long after the window ended isn't a live report. */
const REPORT_LATE_MS = 5 * 60_000;
/** The window on air is always among a screen's latest rounds (the next one is bidding). */
const RECENT_ROUNDS = 3;
const MAX_LIST = 20;
const MAX_BIDS_SCANNED = 40;

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

const isWhole = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;

async function isHostMember(ctx: QueryCtx, userId: Id<"users">, billboard: Doc<"billboards">): Promise<boolean> {
  const workspaceId = billboard.workspaceId;
  if (!workspaceId) return false;
  const member = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_and_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
    .unique();
  return member !== null;
}

/** The paid window this user's company has on air on this screen at `at`, if any. */
async function payerWindowAt(ctx: QueryCtx, userId: Id<"users">, billboardId: Id<"billboards">, at: number): Promise<Doc<"rounds"> | null> {
  const rounds = await ctx.db
    .query("rounds")
    .withIndex("by_billboard_and_createdAt", (q) => q.eq("billboardId", billboardId))
    .order("desc")
    .take(RECENT_ROUNDS);
  for (const round of rounds) {
    if (round.status !== "paid" || !round.winnerBidId || at < round.spotStartAt || at >= round.spotEndAt) continue;
    const bid = await ctx.db.get(round.winnerBidId);
    if (!bid) continue;
    const member = await ctx.db
      .query("advertiserMembers")
      .withIndex("by_advertiser_and_user", (q) => q.eq("advertiserId", bid.advertiserId).eq("userId", userId))
      .unique();
    if (member) return round;
  }
  return null;
}

// ---------------------------------------------------------------- live view

/** Open (or keep open) the live view: the screen sends boxes for the next 20 s. The host always; the payer only while its ad is on air. */
export const watch = mutation({
  args: { billboardId: v.id("billboards") },
  returns: v.object({ role: v.union(v.literal("host"), v.literal("payer")), until: v.number() }),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) fail("NOT_FOUND", "Screen not found");
    const now = Date.now();
    const role = (await isHostMember(ctx, user.userId, billboard))
      ? ("host" as const)
      : (await payerWindowAt(ctx, user.userId, billboard._id, now))
        ? ("payer" as const)
        : null;
    if (!role) fail("NOT_ON_AIR", "The live view is for this screen's host, or the company whose ad is on air now");
    const until = now + REQUEST_MS;
    const existing = await ctx.db
      .query("liveViewRequests")
      .withIndex("by_billboard", (q) => q.eq("billboardId", billboard._id))
      .unique();
    if (!existing) await ctx.db.insert("liveViewRequests", { billboardId: billboard._id, until });
    else if (existing.until < until) await ctx.db.patch(existing._id, { until });
    return { role, until };
  },
});

/** The latest live boxes, or null: nothing sent yet, or (for a payer) the frame isn't from its own paid window. */
export const view = query({
  args: { billboardId: v.id("billboards") },
  returns: v.union(
    v.null(),
    v.object({ boxes: v.array(liveBox), inView: v.number(), looking: v.union(v.number(), v.null()), at: v.number() }),
  ),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const billboard = await ctx.db.get(args.billboardId);
    if (!billboard) return null;
    const frame = await ctx.db
      .query("liveViews")
      .withIndex("by_billboard", (q) => q.eq("billboardId", billboard._id))
      .unique();
    if (!frame) return null;
    // The frame's own (server) time decides what a payer may see, so this query never reads the clock.
    const allowed = (await isHostMember(ctx, user.userId, billboard)) || (await payerWindowAt(ctx, user.userId, billboard._id, frame.at)) !== null;
    if (!allowed) return null;
    return { boxes: frame.boxes, inView: frame.inView, looking: frame.looking, at: frame.at };
  },
});

/** The screen asks whether anyone opened its live view (changes on every renewal; 0 = never). Public by device id, like devices.status. */
export const wanted = query({
  args: { deviceId: v.id("screenDevices") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    const billboardId = device?.billboardId;
    if (!billboardId) return 0;
    const request = await ctx.db
      .query("liveViewRequests")
      .withIndex("by_billboard", (q) => q.eq("billboardId", billboardId))
      .unique();
    return request?.until ?? 0;
  },
});

/** The screen's current boxes. Stored only while a live view is open; `wanted: false` tells the screen to stop sending. */
export const pushFrame = mutation({
  args: {
    deviceId: v.id("screenDevices"),
    deviceKey: v.string(),
    boxes: v.array(liveBox),
    inView: v.number(),
    looking: v.union(v.number(), v.null()),
  },
  returns: v.object({ wanted: v.boolean() }),
  handler: async (ctx, args) => {
    const device = await deviceFor(ctx, args.deviceId, args.deviceKey);
    const billboardId = device.billboardId;
    if (!billboardId) return { wanted: false };
    const now = Date.now();
    const request = await ctx.db
      .query("liveViewRequests")
      .withIndex("by_billboard", (q) => q.eq("billboardId", billboardId))
      .unique();
    if (!request || request.until < now) return { wanted: false };
    if (args.boxes.length > MAX_BOXES) fail("INVALID_INPUT", `At most ${MAX_BOXES} boxes`);
    const inFrame = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
    if (!args.boxes.every((b) => inFrame(b.x) && inFrame(b.y) && inFrame(b.w) && inFrame(b.h))) {
      fail("INVALID_INPUT", "Boxes are fractions of the frame (0..1)");
    }
    if (!isWhole(args.inView, MAX_PEOPLE) || (args.looking !== null && !isWhole(args.looking, args.inView))) {
      fail("INVALID_INPUT", "Counts must be whole numbers; looking can't exceed in view");
    }
    const frame = { billboardId, boxes: args.boxes, inView: args.inView, looking: args.looking, at: now };
    const existing = await ctx.db
      .query("liveViews")
      .withIndex("by_billboard", (q) => q.eq("billboardId", billboardId))
      .unique();
    if (existing) await ctx.db.replace(existing._id, frame);
    else await ctx.db.insert("liveViews", frame);
    return { wanted: true };
  },
});

// ---------------------------------------------------------------- window reports

/** When a window ends, the screen reports what its camera saw. The first report for a window wins; repeats return it. */
export const reportWindow = mutation({
  args: {
    deviceId: v.id("screenDevices"),
    deviceKey: v.string(),
    roundId: v.id("rounds"),
    people: v.number(),
    avgInViewMs: v.number(),
    lookers: v.union(v.number(), v.null()),
    avgLookingMs: v.union(v.number(), v.null()),
  },
  returns: v.object({ reportId: v.id("windowAudiences"), replayed: v.boolean() }),
  handler: async (ctx, args) => {
    const device = await deviceFor(ctx, args.deviceId, args.deviceKey);
    const round = await ctx.db.get(args.roundId);
    if (!round || !device.billboardId || round.billboardId !== device.billboardId) fail("NOT_FOUND", "That window isn't on this screen");
    const existing = await ctx.db
      .query("windowAudiences")
      .withIndex("by_round", (q) => q.eq("roundId", round._id))
      .unique();
    if (existing) return { reportId: existing._id, replayed: true };
    const now = Date.now();
    if (now < round.spotEndAt - REPORT_EARLY_MS) fail("TOO_EARLY", "That window hasn't ended yet");
    if (now > round.spotEndAt + REPORT_LATE_MS) fail("TOO_LATE", "That window ended too long ago");
    const length = round.spotEndAt - round.spotStartAt;
    const validTime = (ms: number) => Number.isFinite(ms) && ms >= 0;
    if (!isWhole(args.people, MAX_PEOPLE) || !validTime(args.avgInViewMs)) fail("INVALID_INPUT", "Bad people count or time in view");
    if ((args.lookers === null) !== (args.avgLookingMs === null)) fail("INVALID_INPUT", "Send both looking numbers, or neither");
    if (args.lookers !== null && (!isWhole(args.lookers, args.people) || !validTime(args.avgLookingMs!))) {
      fail("INVALID_INPUT", "Lookers can't exceed people; looking time can't be negative");
    }
    const winner = round.status === "paid" && round.winnerBidId ? await ctx.db.get(round.winnerBidId) : null;
    // The screen's clock ticks a little past the window's end; nobody watches longer than the window.
    const cap = (ms: number) => Math.round(Math.min(ms, length));
    const reportId = await ctx.db.insert("windowAudiences", {
      roundId: round._id,
      billboardId: round.billboardId,
      workspaceId: round.workspaceId,
      advertiserId: winner?.advertiserId ?? null,
      spotStartAt: round.spotStartAt,
      spotEndAt: round.spotEndAt,
      people: args.people,
      avgInViewMs: cap(args.avgInViewMs),
      lookers: args.lookers,
      avgLookingMs: args.avgLookingMs === null ? null : cap(args.avgLookingMs),
      reportedAt: now,
    });
    return { reportId, replayed: false };
  },
});

const audienceView = v.object({
  people: v.number(),
  avgInViewMs: v.number(),
  lookers: v.union(v.number(), v.null()),
  avgLookingMs: v.union(v.number(), v.null()),
});

const hostWindowRow = v.object({
  roundId: v.id("rounds"),
  billboardId: v.id("billboards"),
  screen: v.string(),
  /** Who paid for the window (null: the house ad played). */
  company: v.union(v.string(), v.null()),
  spotStartAt: v.number(),
  spotEndAt: v.number(),
  audience: audienceView,
});

const audienceOf = (r: Doc<"windowAudiences">): Infer<typeof audienceView> => ({
  people: r.people,
  avgInViewMs: r.avgInViewMs,
  lookers: r.lookers,
  avgLookingMs: r.avgLookingMs,
});

const limitOf = (limit: number | undefined) => Math.min(Math.max(1, Math.floor(limit ?? 10)), MAX_LIST);

/** The host: reported windows on one screen (or every screen of the workspace), newest first. */
export const hostWindows = query({
  args: { billboardId: v.optional(v.id("billboards")), limit: v.optional(v.number()) },
  returns: v.array(hostWindowRow),
  handler: async (ctx, args) => {
    const limit = limitOf(args.limit);
    let rows: Doc<"windowAudiences">[];
    if (args.billboardId) {
      const billboardId = args.billboardId;
      await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, billboardId));
      rows = await ctx.db
        .query("windowAudiences")
        .withIndex("by_billboard_and_spotStartAt", (q) => q.eq("billboardId", billboardId))
        .order("desc")
        .take(limit);
    } else {
      const me = await resolveWorkspace(ctx);
      rows = await ctx.db
        .query("windowAudiences")
        .withIndex("by_workspace_and_spotStartAt", (q) => q.eq("workspaceId", me.workspaceId))
        .order("desc")
        .take(limit);
    }
    const out = [];
    for (const r of rows) {
      out.push({
        roundId: r.roundId,
        billboardId: r.billboardId,
        screen: (await ctx.db.get(r.billboardId))?.name ?? "Screen",
        company: r.advertiserId ? ((await ctx.db.get(r.advertiserId))?.displayName ?? "A company") : null,
        spotStartAt: r.spotStartAt,
        spotEndAt: r.spotEndAt,
        audience: audienceOf(r),
      });
    }
    return out;
  },
});

/** The payer: its recent paid windows, newest first, each with its audience once the window has ended. */
export const myWindows = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      roundId: v.id("rounds"),
      billboardId: v.id("billboards"),
      screen: v.string(),
      spotStartAt: v.number(),
      spotEndAt: v.number(),
      audience: v.union(v.null(), audienceView),
    }),
  ),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx);
    const limit = limitOf(args.limit);
    const bids = await ctx.db
      .query("roundBids")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(MAX_BIDS_SCANNED);
    const out = [];
    for (const bid of bids) {
      if (out.length >= limit) break;
      if (bid.status !== "won") continue;
      const round = await ctx.db.get(bid.roundId);
      if (!round || round.status !== "paid" || round.winnerBidId !== bid._id) continue;
      const report = await ctx.db
        .query("windowAudiences")
        .withIndex("by_round", (q) => q.eq("roundId", round._id))
        .unique();
      out.push({
        roundId: round._id,
        billboardId: round.billboardId,
        screen: (await ctx.db.get(round.billboardId))?.name ?? "Screen",
        spotStartAt: round.spotStartAt,
        spotEndAt: round.spotEndAt,
        audience: report ? audienceOf(report) : null,
      });
    }
    return out;
  },
});
