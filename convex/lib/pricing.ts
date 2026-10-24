/**
 * Deterministic slot pricing harness (ADR 0003). Pure: no database, no clock,
 * no randomness. Same inputs always produce the same amount and explanation.
 *
 * A screen price is a list of STAGES, each `{ key, multiplier, confidence,
 * explanation }`. The combiner multiplies the confidence-weighted multipliers
 * (effective = 1 + (multiplier - 1) x confidence, rounded to 2 dp) onto the
 * base rate and clamps the result to [reserve floor, ceiling].
 *
 *   crowd    camera audience over the trailing 15 min vs this screen's normal
 *   time     local hour-of-day table
 *   event    nearby event uplift            (lib/stages.ts)
 *   scarcity utilization, live interest, last-minute decay (lib/stages.ts)
 *   market   recent sale prices in the same hour band      (lib/stages.ts)
 *
 * Company valuation (lib/valuation.ts) is applied AFTER the screen price,
 * for posted quotes only, and is never part of the buyer-facing explanation.
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

export type StageKey = "crowd" | "time" | "event" | "scarcity" | "market";

/** One pricing stage. `confidence` (0..1) shrinks the multiplier toward 1.0. */
export type PricingStage = {
  key: StageKey;
  multiplier: number;
  confidence: number;
  explanation: string;
};

/** A stage as stored on a quote: includes the weighted multiplier actually used. */
export type AppliedStage = PricingStage & { effective: number };

export type DemandResult = {
  multiplier: number;
  confidence: PricingConfidence;
  basis: string[];
  /** The crowd stage (multiplier = clamped raw ratio, confidence = measurement confidence). */
  stage: PricingStage;
};

export type SlotPrice = {
  slotStartAt: number;
  amountMinor: number;
  computedMinor: number;
  hourFactor: number;
  floorApplied: boolean;
  ceilingApplied: boolean;
  stages: AppliedStage[];
  basis: string[];
};

export type QuotePrice = {
  amountMinor: number;
  confidence: PricingConfidence;
  demandMultiplier: number;
  pricingBasis: string[];
  slotPrices: SlotPrice[];
  ceilingMinor: number;
};

/** Default price ceiling: 4x the base rate (overridable per billboard). */
export const DEFAULT_CEILING_MULTIPLE = 4;

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

export function localTimeLabel(timestampMs: number, utcOffsetMinutes: number): string {
  const local = new Date(timestampMs + utcOffsetMinutes * 60_000);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function hourFactorFor(timestampMs: number, utcOffsetMinutes: number): number {
  return HOUR_FACTORS[localHour(timestampMs, utcOffsetMinutes)] ?? 1.0;
}

/** Ceiling for a screen: explicit value, else 4x base; never below the floor. */
export function effectiveCeiling(
  baseRateMinor: number,
  reserveFloorMinor: number,
  ceilingMinor?: number | null,
): number {
  const c =
    ceilingMinor !== undefined && ceilingMinor !== null && Number.isSafeInteger(ceilingMinor) && ceilingMinor > 0
      ? ceilingMinor
      : baseRateMinor * DEFAULT_CEILING_MULTIPLE;
  return Math.max(c, reserveFloorMinor);
}

/** 1 + (m - 1) x confidence, rounded to 2 dp; invalid input -> 1.0. */
export function effectiveMultiplier(stage: PricingStage): number {
  if (!Number.isFinite(stage.multiplier) || stage.multiplier <= 0) return 1;
  const c = Number.isFinite(stage.confidence) ? Math.min(1, Math.max(0, stage.confidence)) : 0;
  return round2(1 + (stage.multiplier - 1) * c);
}

/**
 * Crowd stage from the trailing audience sample.
 * `audience` null, stale, in the future, or malformed -> baseline 1.0, low confidence.
 */
export function demandFromAudience(
  audience: AudienceSample | null,
  now: number,
  baselinePerBucket?: number,
): DemandResult {
  const baseline = effectiveBaseline(baselinePerBucket);
  if (audience === null) {
    const explanation = "No recent audience data: baseline demand x1.00 (low confidence)";
    return {
      multiplier: 1,
      confidence: "low",
      basis: [explanation],
      stage: { key: "crowd", multiplier: 1, confidence: 0, explanation },
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
    const explanation = "Audience data stale or invalid: baseline demand x1.00 (low confidence)";
    return {
      multiplier: 1,
      confidence: "low",
      basis: [explanation],
      stage: { key: "crowd", multiplier: 1, confidence: 0, explanation },
    };
  }

  const raw = audience.countEstimate / baseline;
  const clamped = Math.min(DEMAND_MULTIPLIER_MAX, Math.max(DEMAND_MULTIPLIER_MIN, raw));
  const stage: PricingStage = {
    key: "crowd",
    multiplier: clamped,
    confidence: audience.confidence,
    explanation: "",
  };
  // Shrink toward 1.0 by confidence: an uncertain count moves the price less.
  const multiplier = effectiveMultiplier(stage);
  const confidence: PricingConfidence =
    audience.confidence >= 0.75 ? "high" : audience.confidence >= 0.4 ? "medium" : "low";

  const sourceLabel = audience.source === "simulated" ? "SIMULATED sensor" : "camera aggregate";
  const measured = audience.window
    ? `Audience ${audience.countEstimate} people in the last 15 min (${sourceLabel}, confidence ${audience.confidence.toFixed(2)}, ${Math.round(audience.window.coverage * 100)}% of the window measured)`
    : `Audience ${audience.countEstimate} people/15min (${sourceLabel}, confidence ${audience.confidence.toFixed(2)})`;
  const basis = [
    `${measured}; ${baseline} people per 15 min is normal here`,
    `Demand multiplier x${multiplier.toFixed(2)} (raw x${round2(raw).toFixed(2)}, clamped to [${DEMAND_MULTIPLIER_MIN}, ${DEMAND_MULTIPLIER_MAX}], weighted by confidence)`,
  ];
  stage.explanation = basis.join("; ");
  return { multiplier, confidence, basis, stage };
}

/** Time-of-day stage. */
export function timeStage(slotStartAt: number, utcOffsetMinutes: number): PricingStage {
  const factor = hourFactorFor(slotStartAt, utcOffsetMinutes);
  return {
    key: "time",
    multiplier: factor,
    confidence: 1,
    explanation: `Local ${localTimeLabel(slotStartAt, utcOffsetMinutes)} is in the x${factor.toFixed(2)} time-of-day band`,
  };
}

const STAGE_WORD: Record<StageKey, string> = {
  crowd: "demand",
  time: "hour",
  event: "event",
  scarcity: "scarcity",
  market: "market",
};

/**
 * Combiner: base x product of effective stage multipliers, rounded, clamped to
 * [floor, ceiling]. Stages are applied in the order given.
 */
export function combineStages(args: {
  baseRateMinor: number;
  reserveFloorMinor: number;
  ceilingMinor: number;
  stages: PricingStage[];
}): { computedMinor: number; amountMinor: number; floorApplied: boolean; ceilingApplied: boolean; stages: AppliedStage[] } {
  let x = args.baseRateMinor;
  const applied: AppliedStage[] = [];
  for (const stage of args.stages) {
    const effective = effectiveMultiplier(stage);
    applied.push({ ...stage, effective });
    x *= effective;
  }
  const computedMinor = Math.round(x);
  const floorApplied = computedMinor < args.reserveFloorMinor;
  const ceilingApplied = !floorApplied && computedMinor > args.ceilingMinor;
  const amountMinor = floorApplied ? args.reserveFloorMinor : ceilingApplied ? args.ceilingMinor : computedMinor;
  return { computedMinor, amountMinor, floorApplied, ceilingApplied, stages: applied };
}

/** Price for one slot: crowd + time stages, plus any extra screen stages. */
export function priceSlot(
  input: SlotPricingInput & { ceilingMinor?: number },
  demand: DemandResult | number,
  extraStages: PricingStage[] = [],
): SlotPrice {
  assertMoney("baseRateMinor", input.baseRateMinor);
  assertMoney("reserveFloorMinor", input.reserveFloorMinor);
  const crowd: PricingStage =
    typeof demand === "number"
      ? { key: "crowd", multiplier: demand, confidence: 1, explanation: `Demand x${demand.toFixed(2)}` }
      : demand.stage;
  if (!Number.isFinite(crowd.multiplier) || crowd.multiplier <= 0) {
    throw new Error(`demand multiplier must be a positive finite number, got ${crowd.multiplier}`);
  }
  const time = timeStage(input.slotStartAt, input.utcOffsetMinutes);
  const ceilingMinor = effectiveCeiling(input.baseRateMinor, input.reserveFloorMinor, input.ceilingMinor);
  const combined = combineStages({
    baseRateMinor: input.baseRateMinor,
    reserveFloorMinor: input.reserveFloorMinor,
    ceilingMinor,
    stages: [crowd, time, ...extraStages],
  });
  const label = localTimeLabel(input.slotStartAt, input.utcOffsetMinutes);
  const factors = combined.stages.map((s) => `x${s.effective.toFixed(2)} ${STAGE_WORD[s.key]}`).join(" ");
  const basis = [
    `Slot ${label} local: ${usd(input.baseRateMinor)} ${factors} = ${usd(combined.computedMinor)}` +
      (combined.floorApplied ? `, raised to reserve floor ${usd(input.reserveFloorMinor)}` : "") +
      (combined.ceilingApplied ? `, capped at ceiling ${usd(ceilingMinor)}` : ""),
    // Extra stages explain themselves when they moved the price.
    ...combined.stages
      .filter((s) => s.key !== "crowd" && s.key !== "time" && s.effective !== 1)
      .map((s) => `  ${STAGE_WORD[s.key]}: ${s.explanation}`),
  ];
  return {
    slotStartAt: input.slotStartAt,
    amountMinor: combined.amountMinor,
    computedMinor: combined.computedMinor,
    hourFactor: time.multiplier,
    floorApplied: combined.floorApplied,
    ceilingApplied: combined.ceilingApplied,
    stages: combined.stages,
    basis,
  };
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
  /** Billboard's price ceiling per slot; defaults to 4x base. */
  ceilingMinor?: number;
  /** Extra screen-price stages per slot (event, scarcity, market), from lib/stages.ts. */
  extraStagesFor?: (slotStartAt: number, index: number) => PricingStage[];
}): QuotePrice {
  if (args.slotStartTimes.length === 0) {
    throw new Error("priceQuote requires at least one slot");
  }
  const demand = demandFromAudience(args.audience, args.now, args.audienceBaselinePerBucket);
  const ceilingMinor = effectiveCeiling(args.baseRateMinor, args.reserveFloorMinor, args.ceilingMinor);
  const slotPrices = args.slotStartTimes.map((slotStartAt, i) =>
    priceSlot(
      {
        baseRateMinor: args.baseRateMinor,
        reserveFloorMinor: args.reserveFloorMinor,
        utcOffsetMinutes: args.utcOffsetMinutes,
        slotStartAt,
        ceilingMinor,
      },
      demand,
      args.extraStagesFor?.(slotStartAt, i) ?? [],
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
    ceilingMinor,
  };
}

/** Coarse local-time band, matching the time-of-day table's groups. */
export function hourBand(timestampMs: number, utcOffsetMinutes: number): string {
  const h = localHour(timestampMs, utcOffsetMinutes);
  if (h < 6) return "overnight";
  if (h < 9) return "morning";
  if (h < 12) return "late-morning";
  if (h < 14) return "lunch";
  if (h < 17) return "afternoon";
  if (h < 20) return "evening";
  return "night";
}
