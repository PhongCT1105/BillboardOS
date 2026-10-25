import { describe, expect, test } from "vitest";
import { FEATURES, featuresFor, fitRidge, predict, simulatedWinner, trainingRows, type Window } from "./lib/priceModel";

/** A simple deterministic random source. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("price model", () => {
  test("features: lags newest first, missing lags fall back to the mean, then the floor", () => {
    const at = Date.UTC(2026, 9, 25, 19, 0); // 12:00 at -420
    const f = featuresFor({ soldNewestFirst: [9, 7], people: 4, at, utcOffsetMinutes: -420, fallbackMinor: 5 });
    expect(f.slice(0, 6)).toEqual([1, 9, 7, 8, 8, 4]);
    expect(f[6]).toBeCloseTo(0, 5); // sin(noon)
    expect(f[7]).toBeCloseTo(-1, 5); // cos(noon)
    expect(featuresFor({ soldNewestFirst: [], people: null, at, utcOffsetMinutes: 0, fallbackMinor: 5 }).slice(1, 6)).toEqual([5, 5, 5, 5, 3]);
    expect(f).toHaveLength(FEATURES.length);
  });

  test("fits a market it can learn: prediction tracks the simulated prices", () => {
    const rand = rng(42);
    const windows: Window[] = [];
    const start = Date.UTC(2026, 9, 20, 0, 0);
    for (let k = 0; k < 2000; k++) {
      const at = start + k * 5 * 60_000;
      const hour = new Date(at - 7 * 3600_000).getUTCHours();
      const people = Math.floor(rand() * 10);
      windows.push({ at, utcOffsetMinutes: -420, people, winnerMinor: simulatedWinner({ baseMinor: 6, hour, people, rand }) });
    }
    const { x, y } = trainingRows(windows, 5);
    const model = fitRidge(x, y)!;
    expect(model.samples).toBeGreaterThan(1500);
    // Better than always guessing the mean.
    const mean = y.reduce((s, v) => s + v, 0) / y.length;
    const baseline = Math.sqrt(y.reduce((s, v) => s + (v - mean) ** 2, 0) / y.length);
    expect(model.rmseMinor).toBeLessThan(baseline);
    // More people in view -> a higher predicted price.
    const row = (people: number) => featuresFor({ soldNewestFirst: [8, 8, 8], people, at: start, utcOffsetMinutes: -420, fallbackMinor: 5 });
    expect(predict(model, row(12))).toBeGreaterThan(predict(model, row(0)));
  });

  test("too little history: no model", () => {
    expect(fitRidge([[1, 2, 3, 4, 5, 6, 7, 8, 9]], [5])).toBeNull();
  });
});
