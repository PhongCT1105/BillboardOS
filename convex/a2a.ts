import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { audienceTags } from "./schema";
import { recordAudit } from "./lib/audit";
import { authenticateAgent, hashKey } from "./lib/agentKeys";
import { WINDOW_MS } from "./lib/rounds";

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
import { requireCustomer, resolveWorkspace } from "./lib/tenancy";

/**
 * Seller-agent data for the x402 server (ADR 0005): agent card, the paid
 * audience report, data-sale recording, and the workspace's negotiation
 * policy. Reports describe screens and crowds in aggregate; never people.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const BUCKET = 15 * 60_000;
const REPORT_WINDOW_MS = 2 * HOUR;
const BANDS = ["overnight", "morning", "late-morning", "lunch", "afternoon", "evening", "night"];

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function workspaceIdOf(ctx: QueryCtx, value: string): Id<"workspaces"> {
  const id = ctx.db.normalizeId("workspaces", value);
  if (!id) fail("NOT_FOUND", "Host not found");
  return id;
}

async function billboardOfWorkspace(ctx: QueryCtx, workspaceId: Id<"workspaces">, billboardId: string): Promise<Doc<"billboards">> {
  const id = ctx.db.normalizeId("billboards", billboardId);
  const b = id ? await ctx.db.get(id) : null;
  if (!b || b.workspaceId !== workspaceId) fail("NOT_FOUND", "That screen is not one of this host's screens");
  return b;
}

// ---------------------------------------------------------------- agent card

export const agentCard = internalQuery({
  args: { workspaceId: v.string() },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    city: v.string(),
    payoutAddress: v.union(v.string(), v.null()),
    negotiation: v.object({ maxRounds: v.number(), offerValiditySeconds: v.number() }),
    screens: v.array(
      v.object({
        billboardId: v.id("billboards"),
        name: v.string(),
        city: v.string(),
        locationLabel: v.string(),
        online: v.boolean(),
        baseRateMinor: v.number(),
        audienceTags: v.union(audienceTags, v.null()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const workspaceId = workspaceIdOf(ctx, args.workspaceId);
    const ws = await ctx.db.get(workspaceId);
    if (!ws) fail("NOT_FOUND", "Host not found");
    const screens = await ctx.db
      .query("billboards")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .take(50);
    return {
      workspaceId,
      name: ws.name,
      city: ws.city,
      payoutAddress: ws.payoutAddress ?? null,
      // Rounds: two turns per company (the host counters once); bidding for a 30 s window lasts 30 s.
      negotiation: { maxRounds: 2, offerValiditySeconds: WINDOW_MS / 1000 },
      screens: screens.map((b) => ({
        billboardId: b._id,
        name: b.name,
        city: b.city,
        locationLabel: b.locationLabel,
        online: b.deviceStatus === "online",
        baseRateMinor: b.baseRateMinor,
        audienceTags: b.audienceTags ?? null,
      })),
    };
  },
});

// ---------------------------------------------------------------- audience report (paid)

/** Before issuing a 402: is this a valid agent key, and is the screen this host's? */
export const authorizeReport = internalMutation({
  args: { token: v.string(), workspaceId: v.string(), billboardId: v.string() },
  returns: v.object({
    agentKeyId: v.id("agentKeys"),
    advertiserId: v.id("advertisers"),
    actor: v.string(),
    billboardId: v.id("billboards"),
    payTo: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const agent = await authenticateAgent(ctx, args.token, null);
    const workspaceId = workspaceIdOf(ctx, args.workspaceId);
    const ws = await ctx.db.get(workspaceId);
    if (!ws) fail("NOT_FOUND", "Host not found");
    const b = await billboardOfWorkspace(ctx, workspaceId, args.billboardId);
    return { agentKeyId: agent.key._id, advertiserId: agent.key.advertiserId, actor: agent.actor, billboardId: b._id, payTo: ws.payoutAddress ?? null };
  },
});

export const audienceReport = internalQuery({
  args: { workspaceId: v.string(), billboardId: v.string() },
  returns: v.object({
    billboard: v.object({
      billboardId: v.id("billboards"),
      name: v.string(),
      city: v.string(),
      locationLabel: v.string(),
      utcOffsetMinutes: v.number(),
      audienceTags: v.union(audienceTags, v.null()),
      normalTrafficPer15Min: v.number(),
    }),
    generatedAt: v.number(),
    crowd: v.object({
      windowMinutes: v.number(),
      buckets: v.array(
        v.object({ bucketStart: v.number(), people: v.number(), peakInView: v.union(v.number(), v.null()), source: v.string(), confidence: v.number() }),
      ),
      totalPeople: v.number(),
      averagePer15Min: v.union(v.number(), v.null()),
      peakInView: v.union(v.number(), v.null()),
      vsNormal: v.union(v.number(), v.null()),
    }),
    upcomingEvents: v.array(
      v.object({
        name: v.string(),
        startsAt: v.number(),
        endsAt: v.number(),
        expectedAttendance: v.union(v.number(), v.null()),
        audienceTags: v.union(audienceTags, v.null()),
        upliftMultiplier: v.number(),
        source: v.string(),
      }),
    ),
    recentClearingPrices: v.array(
      v.object({ slotStartAt: v.number(), hourBand: v.string(), unitPriceMinor: v.number(), kind: v.string(), recordedAt: v.number() }),
    ),
    notes: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const workspaceId = workspaceIdOf(ctx, args.workspaceId);
    const b = await billboardOfWorkspace(ctx, workspaceId, args.billboardId);
    const now = Date.now();
    const from = now - REPORT_WINDOW_MS - (now % BUCKET);
    const buckets = await ctx.db
      .query("audienceAggregates")
      .withIndex("by_billboard_and_bucketStart", (q) => q.eq("billboardId", b._id).gte("bucketStart", from).lte("bucketStart", now))
      .take(16);
    const totalPeople = buckets.reduce((s, x) => s + x.countEstimate, 0);
    const peaks = buckets.map((x) => x.peakInView).filter((p): p is number => typeof p === "number");
    const normal = b.audienceBaselinePerBucket ?? 120;
    const avg = buckets.length ? totalPeople / buckets.length : null;

    const events = await ctx.db
      .query("events")
      .withIndex("by_billboard_and_startsAt", (q) => q.eq("billboardId", b._id).gte("startsAt", now - DAY).lte("startsAt", now + DAY))
      .take(20);

    const sales: Doc<"priceHistory">[] = [];
    for (const band of BANDS) {
      sales.push(
        ...(await ctx.db
          .query("priceHistory")
          .withIndex("by_billboard_and_band_and_recordedAt", (q) => q.eq("billboardId", b._id).eq("hourBand", band))
          .order("desc")
          .take(5)),
      );
    }
    sales.sort((x, y) => y.recordedAt - x.recordedAt);

    const notes = ["Aggregate counts only: no images, faces or identities are stored or sold."];
    if (buckets.length === 0) notes.push("No crowd readings in the last 2 hours; prices fall back to normal traffic.");
    if (buckets.some((x) => x.source === "simulated")) notes.push("Some readings are simulated (demo sensor).");
    return {
      billboard: {
        billboardId: b._id,
        name: b.name,
        city: b.city,
        locationLabel: b.locationLabel,
        utcOffsetMinutes: b.utcOffsetMinutes,
        audienceTags: b.audienceTags ?? null,
        normalTrafficPer15Min: normal,
      },
      generatedAt: now,
      crowd: {
        windowMinutes: REPORT_WINDOW_MS / 60_000,
        buckets: buckets
          .sort((x, y) => x.bucketStart - y.bucketStart)
          .map((x) => ({ bucketStart: x.bucketStart, people: x.countEstimate, peakInView: x.peakInView ?? null, source: x.source, confidence: x.confidence })),
        totalPeople,
        averagePer15Min: avg === null ? null : Math.round(avg * 10) / 10,
        peakInView: peaks.length ? Math.max(...peaks) : null,
        vsNormal: avg === null ? null : Math.round((avg / normal) * 100) / 100,
      },
      upcomingEvents: events
        .filter((e) => e.endsAt >= now)
        .map((e) => ({
          name: e.name,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          expectedAttendance: e.expectedAttendance ?? null,
          audienceTags: e.audienceTags ?? null,
          upliftMultiplier: e.upliftMultiplier,
          source: e.source,
        })),
      recentClearingPrices: sales.slice(0, 10).map((s) => ({
        slotStartAt: s.slotStartAt,
        hourBand: s.hourBand,
        unitPriceMinor: s.unitPriceMinor,
        kind: s.kind,
        recordedAt: s.recordedAt,
      })),
      notes,
    };
  },
});

/**
 * After x402 settlement of a report: record the sale (idempotent on txHash)
 * so it shows as its own revenue line in the host's finance view.
 */
export const recordDataSale = internalMutation({
  args: {
    token: v.string(),
    workspaceId: v.string(),
    billboardId: v.string(),
    amountMinor: v.number(),
    txHash: v.string(),
    network: v.string(),
    payer: v.optional(v.string()),
  },
  returns: v.object({ dataSaleId: v.id("dataSales"), replayed: v.boolean() }),
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0 || args.amountMinor > 100_000) {
      fail("INVALID_INPUT", "amountMinor must be whole cents in (0, 100000]");
    }
    const txHash = args.txHash.trim();
    if (txHash.length < 4 || txHash.length > 200) fail("INVALID_INPUT", "txHash required");
    const existing = await ctx.db
      .query("dataSales")
      .withIndex("by_txHash", (q) => q.eq("txHash", txHash))
      .first();
    if (existing) return { dataSaleId: existing._id, replayed: true };
    // Money already moved; record even if the key was revoked since the challenge.
    const keyHashLookup = await authenticateOrNull(ctx, args.token);
    if (!keyHashLookup) fail("INVALID_KEY", "Unknown agent key");
    const workspaceId = workspaceIdOf(ctx, args.workspaceId);
    const b = await billboardOfWorkspace(ctx, workspaceId, args.billboardId);
    const dataSaleId = await ctx.db.insert("dataSales", {
      workspaceId,
      advertiserId: keyHashLookup.advertiserId,
      agentKeyId: keyHashLookup._id,
      billboardId: b._id,
      product: "audience_report",
      amountMinor: args.amountMinor,
      txHash,
      network: args.network.slice(0, 40),
      payer: args.payer?.slice(0, 100),
      recordedAt: Date.now(),
    });
    const company = (await ctx.db.get(keyHashLookup.advertiserId))?.displayName ?? "unknown company";
    await recordAudit(ctx, {
      workspaceId,
      traceId: `data_sale:${dataSaleId}`,
      actor: `agent:${company}/${keyHashLookup.name}`,
      type: "data_sale.recorded",
      subjectId: dataSaleId,
      reason: `Audience report for ${b.name} sold to ${company} for ${usd(args.amountMinor)} over x402 (tx ${txHash})`,
      data: { amountMinor: args.amountMinor, txHash, network: args.network, billboardId: b._id },
    });
    return { dataSaleId, replayed: false };
  },
});

/** Find a key by its plaintext without rate limiting or status checks (post-settlement bookkeeping only). */
async function authenticateOrNull(ctx: QueryCtx, token: string): Promise<Doc<"agentKeys"> | null> {
  if (!token.startsWith("bos_agent_") || token.length > 200) return null;
  const keyHash = await hashKey(token);
  return await ctx.db
    .query("agentKeys")
    .withIndex("by_hash", (q) => q.eq("keyHash", keyHash))
    .unique();
}

// ---------------------------------------------------------------- data sales (UI)

const dataSaleRow = v.object({
  dataSaleId: v.id("dataSales"),
  product: v.string(),
  billboardName: v.string(),
  companyName: v.string(),
  amountMinor: v.number(),
  txHash: v.string(),
  network: v.string(),
  recordedAt: v.number(),
});

async function saleRows(ctx: QueryCtx, rows: Doc<"dataSales">[]) {
  const out = [];
  for (const s of rows) {
    out.push({
      dataSaleId: s._id,
      product: s.product,
      billboardName: (await ctx.db.get(s.billboardId))?.name ?? "Unknown screen",
      companyName: (await ctx.db.get(s.advertiserId))?.displayName ?? "Unknown company",
      amountMinor: s.amountMinor,
      txHash: s.txHash,
      network: s.network,
      recordedAt: s.recordedAt,
    });
  }
  return out;
}

/** Host finance: data-sale revenue (its own line) plus recent sales. */
export const dataSalesForWorkspace = query({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({ totalMinor: v.number(), count: v.number(), capped: v.boolean(), recent: v.array(dataSaleRow) }),
  handler: async (ctx, args) => {
    const me = await resolveWorkspace(ctx, args.workspaceId);
    const rows = await ctx.db
      .query("dataSales")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", me.workspaceId))
      .order("desc")
      .take(500);
    return {
      totalMinor: rows.reduce((s, r) => s + r.amountMinor, 0),
      count: rows.length,
      capped: rows.length === 500,
      recent: await saleRows(ctx, rows.slice(0, 20)),
    };
  },
});

/** Customer: reports their agents bought. */
export const dataPurchasesMine = query({
  args: { advertiserId: v.optional(v.id("advertisers")) },
  returns: v.array(dataSaleRow),
  handler: async (ctx, args) => {
    const customer = await requireCustomer(ctx, args.advertiserId);
    const rows = await ctx.db
      .query("dataSales")
      .withIndex("by_advertiser", (q) => q.eq("advertiserId", customer.advertiserId))
      .order("desc")
      .take(20);
    return await saleRows(ctx, rows);
  },
});
