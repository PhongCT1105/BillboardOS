/**
 * Simple bidding rounds (spec 2026-10-24-simple-bidding-rounds-design):
 * pure rules, integer cents, no Convex calls. The pipeline is
 * start -> price -> invite -> bid -> close (rounds.ts), then pay -> play.
 *
 * Signals only move the asking price; the floor decides what counts. A
 * missing signal is listed with its reason and never blocks a sale.
 */

export const ROUND_CLOSE_MS = 5_000;
export const CAMERA_COOLDOWN_MS = 60_000;
export const AUTO_SELL_GAP_MS = 120_000;
export const MAX_INVITES = 20;
export const DEFAULT_USUAL_IN_VIEW = 3;
export const CROWD_MAX = 3;
export const EVENT_FACTOR = 1.2;
/** Unknown audience match (no screen or campaign profile) counts as this. */
const NEUTRAL_MATCH = 0.5;

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export type PriceSignal = { key: "crowd" | "event"; factor: number | null; reason: string };

/** Every signal, in a fixed order; `factor: null` when its data is missing (said in `reason`). */
export function priceSignals(i: { peakInView: number | null; usualInView: number | undefined; eventName: string | null }): PriceSignal[] {
  const usual = i.usualInView && i.usualInView > 0 ? i.usualInView : DEFAULT_USUAL_IN_VIEW;
  const crowd: PriceSignal =
    i.peakInView === null
      ? { key: "crowd", factor: null, reason: "No camera reading: crowd not counted" }
      : (() => {
          const factor = Math.round(clamp(i.peakInView / usual, 1, CROWD_MAX) * 100) / 100;
          return { key: "crowd", factor, reason: `${i.peakInView} in view, usually ${usual}: ×${factor.toFixed(2)}` };
        })();
  const event: PriceSignal = i.eventName
    ? { key: "event", factor: EVENT_FACTOR, reason: `${i.eventName} on now: ×${EVENT_FACTOR.toFixed(2)}` }
    : { key: "event", factor: null, reason: "No event" };
  return [crowd, event];
}

/** Floor × every known factor. */
export function askingPrice(floorMinor: number, signals: PriceSignal[]): number {
  return Math.round(signals.reduce((p, s) => (s.factor === null ? p : p * s.factor), floorMinor));
}

export type BidContext = {
  floorMinor: number;
  askingMinor: number;
  match: number | null;
  crowd: number | null;
  maxPerSpotMinor: number;
  budgetLeftMinor: number;
  balanceMinor: number | null;
};
export type BidDecision = { amountMinor: number | null; reasoning: string };
/** How an agent turns an invitation into one sealed answer. Swap in a Claude strategy later. */
export type BidStrategy = (c: BidContext) => BidDecision;

/** Worth = asking × (0.8 + 0.7 × match); bid the lowest of worth and every limit; pass below the floor. */
export const ruleBasedStrategy: BidStrategy = (c) => {
  if (c.balanceMinor === null) return { amountMinor: null, reasoning: "Wallet balance not read yet, so I can't commit to a price" };
  const match = c.match ?? NEUTRAL_MATCH;
  const worth = Math.round(c.askingMinor * (0.8 + 0.7 * match));
  const limits: [number, string][] = [
    [worth, "what it's worth to me"],
    [c.maxPerSpotMinor, `my ${usd(c.maxPerSpotMinor)} per-spot limit`],
    [Math.max(0, c.budgetLeftMinor), "my budget left today"],
    [Math.max(0, c.balanceMinor), "my wallet balance"],
  ];
  const [amount, capped] = limits.reduce((lo, l) => (l[0] < lo[0] ? l : lo));
  const why = `Worth ${usd(worth)} to me (${c.match === null ? "match unknown" : `${Math.round(c.match * 100)}% audience match`}${c.crowd === null ? "" : `, ${c.crowd} people`})`;
  if (amount < c.floorMinor) return { amountMinor: null, reasoning: `${why}; capped by ${capped} at ${usd(amount)}, under the ${usd(c.floorMinor)} floor` };
  return { amountMinor: amount, reasoning: `${why}; bidding ${usd(amount)}${capped === "what it's worth to me" ? "" : `, capped by ${capped}`}` };
};

export type ClosingBid = { id: string; amountMinor: number; answeredAt: number };
export type CloseOutcome = { kind: "unsold" } | { kind: "sold"; winnerId: string; runnerUpId: string | null; priceMinor: number };

/** 0 bids: unsold. 1: the lower of its bid and asking. 2+: runner-up + 1¢ within [floor, own bid]. Ties: earlier bid. */
export function closeOutcome(bids: ClosingBid[], askingMinor: number, floorMinor: number): CloseOutcome {
  if (bids.length === 0) return { kind: "unsold" };
  const ranked = [...bids].sort((a, b) => b.amountMinor - a.amountMinor || a.answeredAt - b.answeredAt);
  const [winner, runnerUp] = ranked;
  const price = runnerUp ? runnerUp.amountMinor + 1 : askingMinor;
  return {
    kind: "sold",
    winnerId: winner.id,
    runnerUpId: runnerUp?.id ?? null,
    priceMinor: Math.max(floorMinor, Math.min(winner.amountMinor, price)),
  };
}
