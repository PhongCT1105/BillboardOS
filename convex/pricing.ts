import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { featuresFor, fitRidge, predict, simulatedWinner, trainingRows, type PriceModel, type Window } from "./lib/priceModel";
import { DEFAULT_WEIGHTS, PEOPLE_FRESH_MS, validateWeights, type PriceWeights } from "./lib/rounds";
import { requireWorkspaceMember, resolveWorkspace, workspaceOfBillboard } from "./lib/tenancy";
import { internal } from "./_generated/api";
import { recordAudit } from "./lib/audit";

/**
 * Pricing data and the price model (lib/priceModel.ts has the math).
 *   - Every closed window is saved (priceWindows): when, people in view, what it sold for.
 *   - `simulate` adds synthetic history so the model can start before live data exists.
 *   - `train` (hourly cron) fits the regression on everything saved; live rows outnumber
 *     simulated ones as the screens sell.
 *   - `predictFor` gives the "predicted price" term for a new window.
 */

const HISTORY_FOR_FEATURES = 20;
const MAX_WINDOWS_PER_SCREEN = 3000;
const MAX_SCREENS = 50;
const SIM_STEP_MS = 5 * 60_000;

export async function latestModel(ctx: QueryCtx): Promise<Doc<"priceModels"> | null> {
  return await ctx.db.query("priceModels").withIndex("by_trainedAt").order("desc").first();
}

export function weightsOf(b: Doc<"billboards">): PriceWeights {
  return b.priceWeights ?? DEFAULT_WEIGHTS;
}

/** People in view now on this screen (its device's camera), or null without a fresh count. */
export async function peopleNow(ctx: QueryCtx, b: Doc<"billboards">, now: number): Promise<number | null> {
  if (!b.deviceId) return null;
  const d = await ctx.db.get(b.deviceId);
  return d?.peopleAt !== undefined && d.peopleNow !== undefined && now - d.peopleAt < PEOPLE_FRESH_MS ? d.peopleNow : null;
}

/** The model's predicted winning price for a window starting at `at` (no model yet: the recent average, else the floor). */
export async function predictFor(
  ctx: QueryCtx,
  b: Doc<"billboards">,
  at: number,
  people: number | null,
): Promise<{ predictedMinor: number; modelId: Id<"priceModels"> | null }> {
  const recent = await ctx.db
    .query("priceWindows")
    .withIndex("by_billboard_and_at", (q) => q.eq("billboardId", b._id).lt("at", at))
    .order("desc")
    .take(HISTORY_FOR_FEATURES);
  const sold = recent.filter((w) => w.winnerMinor !== null).map((w) => w.winnerMinor!);
  const model = await latestModel(ctx);
  if (!model) {
    const avg = sold.length ? Math.round(sold.reduce((s, x) => s + x, 0) / sold.length) : b.reserveFloorMinor;
    return { predictedMinor: Math.max(b.reserveFloorMinor, avg), modelId: null };
  }
  const row = featuresFor({ soldNewestFirst: sold, people, at, utcOffsetMinutes: b.utcOffsetMinutes, fallbackMinor: b.reserveFloorMinor });
  return { predictedMinor: predict(model as PriceModel, row), modelId: model._id };
}

export async function recordWindow(ctx: MutationCtx, w: { billboardId: Id<"billboards">; at: number; utcOffsetMinutes: number; people: number | null; winnerMinor: number | null }) {
  await ctx.db.insert("priceWindows", { ...w, source: "live" });
}

/** Fit the model on every saved window (each screen's history in order) and save it. */
export const train = internalMutation({
  args: {},
  returns: v.union(v.null(), v.object({ samples: v.number(), liveSamples: v.number(), rmseMinor: v.number() })),
  handler: async (ctx) => {
    const x: number[][] = [];
    const y: number[] = [];
    let live = 0;
    for (const b of await ctx.db.query("billboards").take(MAX_SCREENS)) {
      const rows = await ctx.db
        .query("priceWindows")
        .withIndex("by_billboard_and_at", (q) => q.eq("billboardId", b._id))
        .order("desc")
        .take(MAX_WINDOWS_PER_SCREEN);
      rows.reverse();
      const windows: Window[] = rows.map((r) => ({ at: r.at, utcOffsetMinutes: r.utcOffsetMinutes, people: r.people, winnerMinor: r.winnerMinor }));
      const t = trainingRows(windows, b.reserveFloorMinor);
      x.push(...t.x);
      y.push(...t.y);
      live += rows.filter((r) => r.source === "live" && r.winnerMinor !== null).length;
    }
    const model = fitRidge(x, y);
    if (!model) return null;
    await ctx.db.insert("priceModels", { features: [...model.features], coef: model.coef, samples: model.samples, liveSamples: live, rmseMinor: model.rmseMinor, trainedAt: Date.now() });
    return { samples: model.samples, liveSamples: live, rmseMinor: model.rmseMinor };
  },
});

/**
 * Bootstrap: synthetic closed windows (every 5 minutes over the past `days`)
 * for every paired screen, from a market where prices follow the time of day
 * and the crowd. Then train. npx convex run pricing:simulate '{"days": 7}'
 */
export const simulate = internalMutation({
  args: { days: v.optional(v.number()), seed: v.optional(v.number()) },
  returns: v.object({ screens: v.number(), windows: v.number() }),
  handler: async (ctx, args) => {
    const days = Math.min(14, Math.max(1, Math.floor(args.days ?? 7)));
    let s = Math.floor(args.seed ?? 7) >>> 0;
    const rand = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
    const now = Date.now();
    let screens = 0;
    let windows = 0;
    for (const b of await ctx.db.query("billboards").take(MAX_SCREENS)) {
      if (b.retiredAt !== undefined || !b.deviceId) continue;
      screens++;
      const base = Math.max(1, Math.round(b.reserveFloorMinor * 1.2));
      for (let at = now - days * 24 * 3600_000; at < now - SIM_STEP_MS; at += SIM_STEP_MS) {
        const local = new Date(at + b.utcOffsetMinutes * 60_000);
        const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
        const people = Math.floor(rand() * 4 + 8 * Math.max(0, Math.sin(((hour - 7) / 24) * 2 * Math.PI)) * rand());
        await ctx.db.insert("priceWindows", {
          billboardId: b._id,
          at,
          utcOffsetMinutes: b.utcOffsetMinutes,
          people,
          winnerMinor: simulatedWinner({ baseMinor: base, hour, people, rand }),
          source: "sim",
        });
        windows++;
      }
    }
    return { screens, windows };
  },
});

/** The current model and each screen's weights, for the presenter page. */
export const modelInfo = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({ features: v.array(v.string()), coef: v.array(v.number()), samples: v.number(), liveSamples: v.number(), rmseMinor: v.number(), trainedAt: v.number() }),
  ),
  handler: async (ctx) => {
    const m = await latestModel(ctx);
    return m ? { features: m.features, coef: m.coef, samples: m.samples, liveSamples: m.liveSamples, rmseMinor: m.rmseMinor, trainedAt: m.trainedAt } : null;
  },
});

/** Host: this screen's price knobs. */
export const setWeights = mutation({
  args: { billboardId: v.id("billboards"), a: v.number(), b: v.number(), c: v.number(), capMultiplier: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireWorkspaceMember(ctx, await workspaceOfBillboard(ctx, args.billboardId));
    const w = { a: args.a, b: args.b, c: args.c, capMultiplier: args.capMultiplier };
    const problem = validateWeights(w);
    if (problem) throw new ConvexError({ code: "INVALID_INPUT", message: problem });
    const billboard = (await ctx.db.get(args.billboardId))!;
    await ctx.db.patch(args.billboardId, { priceWeights: w });
    await recordAudit(ctx, {
      workspaceId: billboard.workspaceId,
      traceId: `billboard:${billboard._id}`,
      actor: member.actor,
      type: "billboard.floor_changed",
      subjectId: billboard._id,
      reason: `Price weights for ${billboard.name}: a ${w.a}, b ${w.b}¢/person, c ${w.c}¢/brand, cap ${w.capMultiplier}x predicted`,
    });
    return null;
  },
});

/** Host: retrain the price model now (it also retrains every hour). */
export const trainNow = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireWorkspaceMember(ctx, (await resolveWorkspace(ctx)).workspaceId);
    await ctx.scheduler.runAfter(0, internal.pricing.train, {});
    return null;
  },
});
