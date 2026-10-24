/**
 * Forecast for the host autopilot (ADR 0007 §1). Pure: no database, no clock.
 *
 * Expected people in view during a future slot =
 *   the screen's normal people in view
 *   x the hour-of-day curve (lib/pricing HOUR_FACTORS)
 *   x the strongest event overlapping the slot (seeded or host-entered)
 *   x the recent camera trend, fading out the further ahead the slot is.
 *
 * "Normal people in view" comes from the camera when it has a day of history
 * (median of hour-adjusted peak-in-view readings); otherwise from the host's
 * "normal traffic" per 15 minutes (arrivals) converted to people in view.
 * Confidence falls the further ahead the slot is. The camera counts people
 * only; nothing here identifies anyone.
 */
import { BASELINE_AUDIENCE_PER_BUCKET, hourFactorFor } from "./pricing";
import { EVENT_UPLIFT_MAX } from "./stages";
import { audienceMix } from "./moment";
import type { AudienceTags } from "./match";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Share of a 15-minute bucket's arrivals that are in view at once (about a 90-second dwell: 120 arrivals -> 12 in view). */
export const IN_VIEW_PER_ARRIVAL = 0.1;
/** Camera readings needed before the camera, not the host's estimate, sets the normal level. */
export const MIN_CAMERA_POINTS = 4;
/** Readings this recent make the trend. */
export const TREND_WINDOW_MS = HOUR;
/** The camera trend stops mattering for slots this far ahead. */
export const TREND_FADE_MS = 6 * HOUR;
export const TREND_MIN = 0.25;
export const TREND_MAX = 3;
export const CONFIDENCE_MAX = 0.9;
export const CONFIDENCE_MIN = 0.3;
/** Confidence lost per hour of lead time. */
export const CONFIDENCE_PER_HOUR = 0.05;

export type ForecastEvent = {
  name: string;
  startsAt: number;
  endsAt: number;
  upliftMultiplier: number;
  confidence: number;
  audienceTags?: AudienceTags;
};

/** One camera bucket: its start and the most people in view at once. */
export type CameraPoint = { bucketStart: number; peakInView: number };

export type ForecastInput = {
  slotStartAt: number;
  slotEndAt: number;
  now: number;
  utcOffsetMinutes: number;
  /** The host's normal traffic in people per 15 minutes (arrivals); missing = 120. */
  normalTrafficPer15?: number | null;
  /** Camera buckets from about the last day (any order). */
  camera: CameraPoint[];
  /** Events near the slot (only those overlapping it count). */
  events: ForecastEvent[];
  screenTags?: AudienceTags;
};

export type Forecast = {
  /** Expected people in view during the slot (one decimal). */
  expectedPeople: number;
  normalInView: number;
  normalSource: "camera" | "host";
  hourFactor: number;
  eventFactor: number;
  eventName: string | null;
  trendFactor: number;
  /** 0.3 .. 0.9, lower the further ahead. */
  confidence: number;
  /** Audience mix: the screen's usual mix and the event's draw. */
  tags: AudienceTags;
  reasoning: string;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 1 + (uplift - 1) x confidence for the strongest event overlapping the slot (1 with none). */
export function eventFactorFor(
  slotStartAt: number,
  slotEndAt: number,
  events: ForecastEvent[],
): { factor: number; event: ForecastEvent | null } {
  let best: { factor: number; event: ForecastEvent | null } = { factor: 1, event: null };
  for (const e of events) {
    if (!(e.startsAt < slotEndAt && e.endsAt > slotStartAt)) continue;
    const uplift = clamp(finite(e.upliftMultiplier, 1), 1, EVENT_UPLIFT_MAX);
    const conf = clamp(finite(e.confidence, 0), 0, 1);
    const factor = Math.round((1 + (uplift - 1) * conf) * 1000) / 1000;
    if (best.event === null || factor > best.factor) best = { factor, event: e };
  }
  return best;
}

/** Confidence for a slot this far ahead: 0.9 now, 0.05 less per hour, never under 0.3. */
export function confidenceFor(msAhead: number): number {
  return Math.round(clamp(CONFIDENCE_MAX - (Math.max(0, msAhead) / HOUR) * CONFIDENCE_PER_HOUR, CONFIDENCE_MIN, CONFIDENCE_MAX) * 100) / 100;
}

/** Expected people in view for one future slot, with its plain-language reasoning. */
export function forecastSlot(i: ForecastInput): Forecast {
  const traffic = i.normalTrafficPer15 && Number.isFinite(i.normalTrafficPer15) && i.normalTrafficPer15 > 0 ? i.normalTrafficPer15 : BASELINE_AUDIENCE_PER_BUCKET;
  // Camera readings adjusted to an "average hour", so evening and morning readings compare.
  const points = i.camera
    .filter((p) => Number.isFinite(p.peakInView) && p.peakInView >= 0 && p.bucketStart <= i.now)
    .map((p) => ({ at: p.bucketStart, level: p.peakInView / hourFactorFor(p.bucketStart, i.utcOffsetMinutes) }));
  const fromCamera = points.length >= MIN_CAMERA_POINTS;
  const normalInView = Math.max(0.5, fromCamera ? median(points.map((p) => p.level)) : traffic * IN_VIEW_PER_ARRIVAL);

  const recent = points.filter((p) => p.at >= i.now - TREND_WINDOW_MS);
  const ratio = recent.length > 0 ? clamp(recent.reduce((s, p) => s + p.level, 0) / recent.length / normalInView, TREND_MIN, TREND_MAX) : 1;
  const msAhead = Math.max(0, i.slotStartAt - i.now);
  const weight = clamp(1 - msAhead / TREND_FADE_MS, 0, 1);
  const trendFactor = Math.round((1 + (ratio - 1) * weight) * 1000) / 1000;

  const mid = i.slotStartAt + (i.slotEndAt - i.slotStartAt) / 2;
  const hourFactor = hourFactorFor(mid, i.utcOffsetMinutes);
  const { factor: eventFactor, event } = eventFactorFor(i.slotStartAt, i.slotEndAt, i.events);

  const expectedPeople = Math.round(normalInView * hourFactor * eventFactor * trendFactor * 10) / 10;
  const confidence = confidenceFor(msAhead);
  const parts = [
    `normal ${round1(normalInView)} in view (${fromCamera ? "camera, last day" : `host estimate from ${traffic} people per 15 min`})`,
    `time of day ×${hourFactor.toFixed(2)}`,
  ];
  if (event) parts.push(`${event.name} ×${eventFactor.toFixed(2)}`);
  if (trendFactor !== 1) parts.push(`camera trend ×${trendFactor.toFixed(2)}`);
  return {
    expectedPeople,
    normalInView: round1(normalInView),
    normalSource: fromCamera ? "camera" : "host",
    hourFactor,
    eventFactor,
    eventName: event?.name ?? null,
    trendFactor,
    confidence,
    tags: audienceMix(i.screenTags, event?.audienceTags),
    reasoning: `forecast ${round1(expectedPeople)} people: ${parts.join(", ")}; confidence ${Math.round(confidence * 100)}%`,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
