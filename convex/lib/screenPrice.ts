import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { loadTrailingAudience } from "./audienceWindow";
import { hourBand, hourFactorFor, priceQuote, type QuotePrice } from "./pricing";
import {
  EVENT_MARGIN_MS,
  MARKET_LOOKBACK_MS,
  NEIGHBOR_WINDOW_MS,
  eventStage,
  marketStage,
  scarcityStage,
} from "./stages";

const MAX_NEIGHBOR_SLOTS = 300;
const MAX_OPEN_QUOTES = 100;
const MAX_EVENTS = 20;
const MAX_SALES_PER_BAND = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

type SlotRef = { _id: Id<"slots">; startAt: number; state: Doc<"slots">["state"] };

/**
 * Load everything the screen-price stages need for a set of slots on one
 * billboard, then price them (crowd, time, event, scarcity, market).
 * The same function powers quotes, the player's house ad and auction reserves.
 *
 * `excludeCampaignId`: the asking buyer's own open quotes don't count as
 * "other buyers looking". `extraInterest`: e.g. auction watchers per slot.
 */
export async function computeScreenPrice(
  db: QueryCtx["db"],
  billboard: Doc<"billboards">,
  slots: SlotRef[],
  now: number,
  opts: {
    excludeCampaignId?: Id<"campaigns">;
    extraInterest?: Map<Id<"slots">, number>;
  } = {},
): Promise<{ price: QuotePrice; audienceAggregateId: Id<"audienceAggregates"> | undefined }> {
  const audience = await loadTrailingAudience(db, billboard._id, now);
  const starts = slots.map((s) => s.startAt);
  const minStart = Math.min(...starts);
  const maxStart = Math.max(...starts);

  // Neighbors for utilization (one bounded range read).
  const nearby = await db
    .query("slots")
    .withIndex("by_billboard_and_startAt", (q) =>
      q
        .eq("billboardId", billboard._id)
        .gte("startAt", minStart - NEIGHBOR_WINDOW_MS)
        .lte("startAt", maxStart + NEIGHBOR_WINDOW_MS),
    )
    .take(MAX_NEIGHBOR_SLOTS);

  // Live interest: distinct other campaigns with an open, unexpired quote per slot.
  const openQuotes = await db
    .query("quotes")
    .withIndex("by_billboard_and_expiresAt", (q) => q.eq("billboardId", billboard._id).gt("expiresAt", now))
    .take(MAX_OPEN_QUOTES);
  const interest = new Map<string, Set<string>>();
  for (const q of openQuotes) {
    if (q.status !== "open" || q.campaignId === opts.excludeCampaignId) continue;
    for (const slotId of q.slotIds) {
      const set = interest.get(slotId) ?? new Set<string>();
      set.add(q.campaignId);
      interest.set(slotId, set);
    }
  }

  // Events overlapping the window (events last at most a day).
  const events = await db
    .query("events")
    .withIndex("by_billboard_and_startsAt", (q) =>
      q
        .eq("billboardId", billboard._id)
        .gte("startsAt", minStart - DAY_MS)
        .lte("startsAt", maxStart + EVENT_MARGIN_MS),
    )
    .take(MAX_EVENTS);

  // Market history per hour band (cached per band).
  const salesByBand = new Map<string, { normalizedRatio: number }[]>();
  async function salesFor(band: string) {
    const cached = salesByBand.get(band);
    if (cached) return cached;
    const rows = await db
      .query("priceHistory")
      .withIndex("by_billboard_and_band_and_recordedAt", (q) =>
        q
          .eq("billboardId", billboard._id)
          .eq("hourBand", band)
          .gte("recordedAt", now - MARKET_LOOKBACK_MS)
          .lte("recordedAt", now),
      )
      .order("desc")
      .take(MAX_SALES_PER_BAND);
    salesByBand.set(band, rows);
    return rows;
  }
  const bandSales = new Map<number, { band: string; sales: { normalizedRatio: number }[] }>();
  for (const s of slots) {
    const band = hourBand(s.startAt, billboard.utcOffsetMinutes);
    bandSales.set(s.startAt, { band, sales: await salesFor(band) });
  }

  const price = priceQuote({
    baseRateMinor: billboard.baseRateMinor,
    reserveFloorMinor: billboard.reserveFloorMinor,
    utcOffsetMinutes: billboard.utcOffsetMinutes,
    audienceBaselinePerBucket: billboard.audienceBaselinePerBucket,
    ceilingMinor: billboard.priceCeilingMinor,
    slotStartTimes: starts,
    audience: audience.sample,
    now,
    extraStagesFor: (slotStartAt, i) => {
      const slot = slots[i];
      const others = nearby.filter((n) => n._id !== slot._id && Math.abs(n.startAt - slotStartAt) <= NEIGHBOR_WINDOW_MS);
      const live = (interest.get(slot._id)?.size ?? 0) + (opts.extraInterest?.get(slot._id) ?? 0);
      const market = bandSales.get(slotStartAt)!;
      return [
        eventStage(slotStartAt, events),
        scarcityStage({
          slotStartAt,
          now,
          neighbors: others.map((n) => ({ startAt: n.startAt, state: n.state })),
          liveInterest: live,
          available: slot.state === "available",
        }),
        marketStage(market.band, market.sales),
      ];
    },
  });
  return { price, audienceAggregateId: audience.newest?._id };
}

/** Time-adjusted ratio for market history: price / (base x hour factor). */
export function normalizedSaleRatio(billboard: Doc<"billboards">, slotStartAt: number, unitPriceMinor: number): number {
  const denom = billboard.baseRateMinor * hourFactorFor(slotStartAt, billboard.utcOffsetMinutes);
  return denom > 0 ? Math.round((unitPriceMinor / denom) * 1000) / 1000 : 1;
}
