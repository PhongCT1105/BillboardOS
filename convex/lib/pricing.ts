/**
 * Deterministic slot pricing. Pure: no database, no clock, no randomness.
 * Same inputs always produce the same amount and the same explanation.
 *
 * price = round(baseRate * demandMultiplier * hourFactor), never below reserveFloor.
 *
 * - demandMultiplier: recent audience count vs. a baseline, clamped, and
 *   shrunk toward 1.0 by the measurement's confidence. Missing or stale
 *   audience data -> 1.0 (baseline price) with "low" confidence.
 * - hourFactor: fixed table by local hour of the slot start.
 */

export const PRICING_POLICY_VERSION = "pricing-v1";

/** Expected people per 15-minute bucket at "normal" demand. */
export const BASELINE_AUDIENCE_PER_BUCKET = 120;
export const DEMAND_MULTIPLIER_MIN = 0.8;
export const DEMAND_MULTIPLIER_MAX = 2.0;
/** Audience aggregates older than this (relative to `now`) are ignored. */
export const AUDIENCE_STALE_AFTER_MS = 60 * 60 * 1000;

/** Local-hour multipliers. Index = hour 0..23. */
export const HOUR_FACTORS: readonly number[] = [
  0.6, 0.6, 0.6, 0.6, 0.6, 0.6, // 00-05 overnight
  1.1, 1.1, 1.1, // 06-08 morning commute
  1.0, 1.0, 1.0, // 09-11
  1.15, 1.15, // 12-13 lunch
  1.0, 1.0, 1.0, // 14-16
  1.25, 1.25, 1.25, // 17-19 evening commute
  0.85, 0.85, 0.85, 0.85, // 20-23
];

export type PricingConfidence = "low" | "medium" | "high";

export type AudienceSample = {
  countEstimate: number;
  bucketStart: number;
  source: "camera" | "simulated";
  /** 0..1 */
  confidence: number;
};

export type SlotPricingInput = {
  baseRateMinor: number;
  reserveFloorMinor: number;
  utcOffsetMinutes: number;
  slotStartAt: number;
};

export type DemandResult = {
  multiplier: number;
  confidence: PricingConfidence;
  basis: string[];
};

export type SlotPrice = {
  amountMinor: number;
  hourFactor: number;
  floorApplied: boolean;
  basis: string[];
};

export type QuotePrice = {
  amountMinor: number;
  confidence: PricingConfidence;
  demandMultiplier: number;
  pricingBasis: string[];
  slotPrices: SlotPrice[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function usd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

function assertMoney(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (minor units), got ${value}`);
  }
}

/** Local hour (0..23) of a UTC timestamp under a fixed offset. */
export function localHour(timestampMs: number, utcOffsetMinutes: number): number {
  const local = new Date(timestampMs + utcOffsetMinutes * 60_000);
  return local.getUTCHours();
}

function localTimeLabel(timestampMs: number, utcOffsetMinutes: number): string {
  const local = new Date(timestampMs + utcOffsetMinutes * 60_000);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function hourFactorFor(timestampMs: number, utcOffsetMinutes: number): number {
  return HOUR_FACTORS[localHour(timestampMs, utcOffsetMinutes)] ?? 1.0;
}

/**
 * Demand multiplier from the most recent audience sample.
 * `audience` null, stale, in the future, or malformed -> baseline 1.0, low confidence.
 */
export function demandFromAudience(
  audience: AudienceSample | null,
  now: number,
): DemandResult {
  if (audience === null) {
    return {
      multiplier: 1,
      confidence: "low",
      basis: ["No recent audience data: baseline demand x1.00 (low confidence)"],
    };
  }
  const age = now - audience.bucketStart;
  const valid =
    Number.isFinite(audience.countEstimate) &&
    audience.countEstimate >= 0 &&
    Number.isFinite(audience.confidence) &&
    audience.confidence >= 0 &&
    audience.confidence <= 1 &&
    age >= 0 &&
    age <= AUDIENCE_STALE_AFTER_MS;
  if (!valid) {
    return {
      multiplier: 1,
      confidence: "low",
      basis: ["Audience data stale or invalid: baseline demand x1.00 (low confidence)"],
    };
  }

  const raw = audience.countEstimate / BASELINE_AUDIENCE_PER_BUCKET;
  const clamped = Math.min(DEMAND_MULTIPLIER_MAX, Math.max(DEMAND_MULTIPLIER_MIN, raw));
  // Shrink toward 1.0 by confidence: an uncertain count moves the price less.
  const multiplier = round2(1 + (clamped - 1) * audience.confidence);
  const confidence: PricingConfidence =
    audience.confidence >= 0.75 ? "high" : audience.confidence >= 0.4 ? "medium" : "low";

  const sourceLabel = audience.source === "simulated" ? "SIMULATED sensor" : "camera aggregate";
  return {
    multiplier,
    confidence,
    basis: [
      `Audience ${audience.countEstimate} people/15min (${sourceLabel}, confidence ${audience.confidence.toFixed(2)}) vs baseline ${BASELINE_AUDIENCE_PER_BUCKET}`,
      `Demand multiplier x${multiplier.toFixed(2)} (raw x${round2(raw).toFixed(2)}, clamped to [${DEMAND_MULTIPLIER_MIN}, ${DEMAND_MULTIPLIER_MAX}], weighted by confidence)`,
    ],
  };
}

/** Price for one slot given an already-computed demand multiplier. */
export function priceSlot(input: SlotPricingInput, demandMultiplier: number): SlotPrice {
  assertMoney("baseRateMinor", input.baseRateMinor);
  assertMoney("reserveFloorMinor", input.reserveFloorMinor);
  if (!Number.isFinite(demandMultiplier) || demandMultiplier <= 0) {
    throw new Error(`demandMultiplier must be a positive finite number, got ${demandMultiplier}`);
  }
  const hourFactor = hourFactorFor(input.slotStartAt, input.utcOffsetMinutes);
  const computed = Math.round(input.baseRateMinor * demandMultiplier * hourFactor);
  const floorApplied = computed < input.reserveFloorMinor;
  const amountMinor = floorApplied ? input.reserveFloorMinor : computed;
  const label = localTimeLabel(input.slotStartAt, input.utcOffsetMinutes);
  const basis = [
    `Slot ${label} local: ${usd(input.baseRateMinor)} x${demandMultiplier.toFixed(2)} demand x${hourFactor.toFixed(2)} hour = ${usd(computed)}` +
      (floorApplied ? `, raised to reserve floor ${usd(input.reserveFloorMinor)}` : ""),
  ];
  return { amountMinor, hourFactor, floorApplied, basis };
}

/** Price a set of slots on one billboard. Total = sum of per-slot prices. */
export function priceQuote(args: {
  baseRateMinor: number;
  reserveFloorMinor: number;
  utcOffsetMinutes: number;
  slotStartTimes: number[];
  audience: AudienceSample | null;
  now: number;
}): QuotePrice {
  if (args.slotStartTimes.length === 0) {
    throw new Error("priceQuote requires at least one slot");
  }
  const demand = demandFromAudience(args.audience, args.now);
  const slotPrices = args.slotStartTimes.map((slotStartAt) =>
    priceSlot(
      {
        baseRateMinor: args.baseRateMinor,
        reserveFloorMinor: args.reserveFloorMinor,
        utcOffsetMinutes: args.utcOffsetMinutes,
        slotStartAt,
      },
      demand.multiplier,
    ),
  );
  const amountMinor = slotPrices.reduce((sum, s) => sum + s.amountMinor, 0);
  const pricingBasis = [
    `Policy ${PRICING_POLICY_VERSION}: base ${usd(args.baseRateMinor)}/slot, reserve floor ${usd(args.reserveFloorMinor)}/slot`,
    ...demand.basis,
    ...slotPrices.flatMap((s) => s.basis),
    `Total ${usd(amountMinor)} for ${slotPrices.length} slot(s), confidence ${demand.confidence}`,
  ];
  return {
    amountMinor,
    confidence: demand.confidence,
    demandMultiplier: demand.multiplier,
    pricingBasis,
    slotPrices,
  };
}
