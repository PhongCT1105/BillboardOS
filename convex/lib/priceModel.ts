/**
 * The price model: a small time-series regression that predicts what the
 * next 30-second window on a screen sells for, from its recent winning
 * prices, the people in view and the time of day. Ridge regression solved
 * in closed form; pure functions, integer cents in and out.
 *
 * Trained (pricing.ts) on the stored history of closed windows, live and
 * simulated; used for the "a x predicted price" term of every offer.
 */

export const FEATURES = ["bias", "lag1", "lag2", "lag3", "mean10", "people", "hourSin", "hourCos", "weekend"] as const;
export type FeatureName = (typeof FEATURES)[number];

/** One closed window: what it sold for (null: unsold), how many people were in view, when (local time from the offset). */
export type Window = { at: number; utcOffsetMinutes: number; people: number | null; winnerMinor: number | null };

export type PriceModel = { features: readonly string[]; coef: number[]; samples: number; rmseMinor: number };

const LAGS = 3;
const MEAN_OF = 10;
const DEFAULT_PEOPLE = 3;

/**
 * Features for the window at `at`, given the screen's earlier sold prices
 * (newest first, cents). Missing lags fall back to the mean of what there is,
 * then to `fallbackMinor` (the floor).
 */
export function featuresFor(i: { soldNewestFirst: number[]; people: number | null; at: number; utcOffsetMinutes: number; fallbackMinor: number }): number[] {
  const sold = i.soldNewestFirst;
  const mean = sold.length ? sold.slice(0, MEAN_OF).reduce((s, x) => s + x, 0) / Math.min(sold.length, MEAN_OF) : i.fallbackMinor;
  const lag = (k: number) => sold[k] ?? mean;
  const local = new Date(i.at + i.utcOffsetMinutes * 60_000);
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  const day = local.getUTCDay();
  return [1, lag(0), lag(1), lag(2), mean, i.people ?? DEFAULT_PEOPLE, Math.sin((2 * Math.PI * hour) / 24), Math.cos((2 * Math.PI * hour) / 24), day === 0 || day === 6 ? 1 : 0];
}

/** Training rows from a screen's windows (oldest first): every sold window, featured on the sold windows before it. */
export function trainingRows(windows: Window[], fallbackMinor: number): { x: number[][]; y: number[] } {
  const x: number[][] = [];
  const y: number[] = [];
  const sold: number[] = [];
  for (const w of windows) {
    if (w.winnerMinor !== null) {
      if (sold.length >= LAGS) {
        x.push(featuresFor({ soldNewestFirst: [...sold].reverse(), people: w.people, at: w.at, utcOffsetMinutes: w.utcOffsetMinutes, fallbackMinor }));
        y.push(w.winnerMinor);
      }
      sold.push(w.winnerMinor);
    }
  }
  return { x, y };
}

/** Solve A x = b by Gaussian elimination with partial pivoting (A is small and square). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const p = M[col][col];
    if (Math.abs(p) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / p;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

/** Ridge regression (the bias is not penalized). Null with too few rows to learn anything. */
export function fitRidge(x: number[][], y: number[], lambda = 1): PriceModel | null {
  const n = FEATURES.length;
  if (x.length < n * 2) return null;
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  for (let r = 0; r < x.length; r++) {
    for (let i = 0; i < n; i++) {
      b[i] += x[r][i] * y[r];
      for (let j = 0; j < n; j++) A[i][j] += x[r][i] * x[r][j];
    }
  }
  for (let i = 1; i < n; i++) A[i][i] += lambda;
  const coef = solve(A, b);
  const se = x.reduce((s, row, r) => s + (predictRaw(coef, row) - y[r]) ** 2, 0);
  return { features: FEATURES, coef, samples: x.length, rmseMinor: Math.round(Math.sqrt(se / x.length) * 100) / 100 };
}

function predictRaw(coef: number[], row: number[]): number {
  return row.reduce((s, v, i) => s + v * (coef[i] ?? 0), 0);
}

/** Predicted winning price in cents (never negative). */
export function predict(model: PriceModel, row: number[]): number {
  return Math.max(0, Math.round(predictRaw(model.coef, row)));
}

/**
 * The simulator's market: what a window sells for, from a base price, the
 * time of day (busier around noon and the evening), the people in view and
 * noise. Deterministic given `rand`. Used to bootstrap the model before there
 * is enough live history.
 */
export function simulatedWinner(i: { baseMinor: number; hour: number; people: number; rand: () => number }): number | null {
  const daily = 1 + 0.35 * Math.max(0, Math.sin(((i.hour - 7) / 24) * 2 * Math.PI)) + 0.25 * Math.exp(-((i.hour - 19) ** 2) / 4);
  const crowd = 1 + 0.08 * Math.min(i.people, 15);
  const noise = 0.85 + 0.3 * i.rand();
  if (i.rand() < 0.08) return null; // nobody bid
  return Math.max(1, Math.round(i.baseMinor * daily * crowd * noise));
}
