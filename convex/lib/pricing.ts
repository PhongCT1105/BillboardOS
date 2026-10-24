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

/** Default "normal traffic" (people per 15-minute bucket); billboards may override. */
export const BASELINE_AUDIENCE_PER_BUCKET = 120;

/** A billboard's normal traffic, falling back to the default for missing/invalid values. */
export function effectiveBaseline(perBucket: number | undefined | null): number {
  return perBucket !== undefined && perBucket !== null && Number.isFinite(perBucket) && perBucket > 0
    ? perBucket
    : BASELINE_AUDIENCE_PER_BUCKET;
}
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
  /** Set when the sample is a trailing 15-minute window (see trailingAudience). */
  window?: { coverage: number };
};

/** Audience buckets are 15 minutes, aligned to the clock (matches slot length). */
export const AUDIENCE_BUCKET_MS = 15 * 60 * 1000;
/** If less than half of the trailing window has measurements, confidence is capped (reads "low"). */
export const LOW_COVERAGE_CONFIDENCE_CAP = 0.3;

export type AudienceBucket = {
  bucketStart: number;
  countEstimate: number;
  source: "camera" | "simulated";
  confidence: number;
};

/**
 * Audience over the trailing 15 minutes ending at `now`:
 *   current bucket count + previous bucket count x (share of the previous bucket
 *   still inside the window).
 * E.g. 5 min into a bucket: current + previous x 10/15.
 * Missing buckets contribute nothing; if under half the window is covered by
 * data, confidence is capped at LOW_COVERAGE_CONFIDENCE_CAP. Neither bucket -> null.
 */
export function trailingAudience(buckets: AudienceBucket[], now: number): AudienceSample | null {
  const B = AUDIENCE_BUCKET_MS;
  const currentStart = now - (now % B);
  const cur = buckets.find((b) => b.bucketStart === currentStart) ?? null;
  const prev = buckets.find((b) => b.bucketStart === currentStart - B) ?? null;
  if (!cur && !prev) return null;

  const elapsed = now - currentStart;
  const prevShare = (B - elapsed) / B;
  const countEstimate = Math.round(
    (cur?.countEstimate ?? 0) + (prev ? prev.countEstimate * prevShare : 0),
  );
  const curWeight = cur ? elapsed : 0;
  const prevWeight = prev ? B - elapsed : 0;
  const coverage = (curWeight + prevWeight) / B;
  let confidence =
    curWeight + prevWeight > 0
      ? ((cur ? cur.confidence * curWeight : 0) + (prev ? prev.confidence * prevWeight : 0)) /
        (curWeight + prevWeight)
      : (cur ?? prev)!.confidence;
  if (coverage < 0.5) confidence = Math.min(confidence, LOW_COVERAGE_CONFIDENCE_CAP);
  const source = cur?.source === "simulated" || prev?.source === "simulated" ? "simulated" : "camera";
  return { countEstimate, bucketStart: now, source, confidence, window: { coverage } };
}

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
  baselinePerBucket?: number,
): DemandResult {
  const baseline = effectiveBaseline(baselinePerBucket);
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

  const raw = audience.countEstimate / baseline;
  const clamped = Math.min(DEMAND_MULTIPLIER_MAX, Math.max(DEMAND_MULTIPLIER_MIN, raw));
  // Shrink toward 1.0 by confidence: an uncertain count moves the price less.
  const multiplier = round2(1 + (clamped - 1) * audience.confidence);
  const confidence: PricingConfidence =
    audience.confidence >= 0.75 ? "high" : audience.confidence >= 0.4 ? "medium" : "low";

  const sourceLabel = audience.source === "simulated" ? "SIMULATED sensor" : "camera aggregate";
  const measured = audience.window
    ? `Audience ${audience.countEstimate} people in the last 15 min (${sourceLabel}, confidence ${audience.confidence.toFixed(2)}, ${Math.round(audience.window.coverage * 100)}% of the window measured)`
    : `Audience ${audience.countEstimate} people/15min (${sourceLabel}, confidence ${audience.confidence.toFixed(2)})`;
  return {
    multiplier,
    confidence,
    basis: [
      `${measured}; ${baseline} people per 15 min is normal here`,
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
  /** Billboard's normal traffic per 15 min; defaults to BASELINE_AUDIENCE_PER_BUCKET. */
  audienceBaselinePerBucket?: number;
}): QuotePrice {
  if (args.slotStartTimes.length === 0) {
    throw new Error("priceQuote requires at least one slot");
  }
  const demand = demandFromAudience(args.audience, args.now, args.audienceBaselinePerBucket);
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
