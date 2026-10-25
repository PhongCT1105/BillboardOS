import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { money } from "../lib/format";
import { useNow } from "../lib/hooks";
import { Card, ErrorLine, Pill, primaryBtn, useAction } from "../customer/ui";

type Live = FunctionReturnType<typeof api.rounds.live>;
type Round = NonNullable<Live["screens"][number]["round"]>;
type Bid = Round["bids"][number];

const ROW_H = 68;
const WINDOW_MS = 30_000;

/** Where a company stands right now: its agreed price, else its latest counter; unanswered and passed sink. */
function standing(b: Bid): { value: number | null; tier: number } {
  if (b.status === "won") return { value: b.amountMinor, tier: 0 };
  if (b.status === "bid") return { value: b.amountMinor, tier: 1 };
  if (b.status === "invited" && b.amountMinor !== null) return { value: b.amountMinor, tier: 2 };
  if (b.status === "invited") return { value: null, tier: 3 };
  return { value: b.amountMinor, tier: 4 };
}

function ranked(bids: Bid[]): Bid[] {
  return [...bids].sort((x, y) => {
    const a = standing(x);
    const b = standing(y);
    if (a.tier <= 2 && b.tier <= 2) return (b.value ?? 0) - (a.value ?? 0) || (x.agreedAt ?? Infinity) - (y.agreedAt ?? Infinity) || a.tier - b.tier;
    return a.tier - b.tier || (y.offerMinor ?? 0) - (x.offerMinor ?? 0);
  });
}

const STATE: Record<Bid["status"], { label: string; tone: "accent" | "danger" | "muted" | "ok" }> = {
  invited: { label: "Thinking", tone: "muted" },
  bid: { label: "Agreed", tone: "ok" },
  passed: { label: "Passed", tone: "muted" },
  won: { label: "Won", tone: "ok" },
  lost: { label: "Lost", tone: "muted" },
  defaulted: { label: "Didn't pay", tone: "danger" },
};

/**
 * The live sale on one screen: back-to-back 30-second windows. While one
 * window plays, every matching company negotiates the next one with the host
 * (two turns each); at the end the highest agreed price wins. A leaderboard
 * re-ranks as values change, and the graph shows each offer and counter.
 */
export function RoundsPanel({ billboardId }: { billboardId: Id<"billboards"> }) {
  const live = useQuery(api.rounds.live, {});
  const sellNow = useMutation(api.rounds.sellNow);
  const setAutoSell = useMutation(api.rounds.setAutoSell);
  const sell = useAction();
  const toggle = useAction();
  const [note, setNote] = useState<string | null>(null);
  const now = useNow(250);

  if (live === undefined) return <div className="h-64 animate-pulse rounded-lg bg-panel" />;
  const screen = live.screens.find((s) => s.billboardId === billboardId);
  const round = screen?.round ?? null;
  const previous = screen?.previous ?? null;
  // What plays now: the last closed window whose time covers now.
  const onAir = [previous, round].find((r) => r && r.status !== "bidding" && r.spotStartAt <= now && now < r.spotEndAt) ?? null;

  async function start() {
    setNote(null);
    const r = await sell.run(() => sellNow({ billboardId }));
    if (r?.reason) setNote(r.reason);
  }

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Live sale · 30-second windows</h2>
          <p className="text-sm text-muted">While one window plays, company agents negotiate the next with you, two turns each. The highest agreed price wins when time is up.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted" title="Keeps the 30-second loop running on online screens. Each company's daily budget caps what it spends.">
            <input type="checkbox" checked={live.autoSell} disabled={toggle.busy} onChange={(e) => toggle.run(() => setAutoSell({ enabled: e.target.checked }))} className="h-4 w-4 accent-accent" />
            Auto-sell
          </label>
          <button type="button" className={`${primaryBtn} min-h-11`} disabled={sell.busy || round?.status === "bidding"} onClick={start}>
            {round?.status === "bidding" ? "Selling…" : "Start selling"}
          </button>
        </div>
      </div>
      <ErrorLine error={sell.error ?? toggle.error} />
      {note && <p className="text-sm text-amber-300">{note}</p>}

      <NowPlaying round={onAir} />

      {!round ? (
        <p className="text-sm text-muted">No sale yet on this screen. It starts on its own when the screen comes online, or press Start selling.</p>
      ) : round.status === "bidding" ? (
        <Bidding round={round} now={now} />
      ) : (
        <Closed round={round} />
      )}
    </Card>
  );
}

function NowPlaying({ round }: { round: Round | null }) {
  if (!round || round.status === "unsold") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-ink px-4 py-3 text-sm">
        <span>
          <span className="text-muted">On screen now:</span> <strong>BillboardOS house ad</strong>
        </span>
        {round?.outcome && (
          <span className="max-w-[70ch] truncate text-xs text-faint" title={round.outcome}>
            {round.outcome}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-emerald-400/60 bg-emerald-400/10 px-4 py-3 text-sm">
      <span>
        <span className="text-muted">On screen now:</span> <strong>{round.winner}</strong> at <span className="tabular font-mono">{money(round.priceMinor ?? 0)}</span>
        {round.status === "awarded" && <span className="text-muted"> · paying over x402…</span>}
      </span>
      {round.txUrl && (
        <a href={round.txUrl} target="_blank" rel="noreferrer" className="text-xs text-accent underline-offset-4 hover:underline">
          Payment on Basescan
        </a>
      )}
    </div>
  );
}

function Bidding({ round, now }: { round: Round; now: number }) {
  const left = Math.max(0, round.closesAt - now);
  const order = ranked(round.bids);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-sm text-muted">
            Selling {new Date(round.spotStartAt).toLocaleTimeString()}–{new Date(round.spotEndAt).toLocaleTimeString()} · {round.bids.length} {round.bids.length === 1 ? "company" : "companies"} offered
          </p>
          <p className="tabular font-mono text-3xl font-semibold text-accent" aria-live="polite">
            {Math.ceil(left / 1000)}s
          </p>
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-line" aria-hidden>
          <div className="h-full bg-accent transition-[width] duration-200 ease-linear" style={{ width: `${(left / WINDOW_MS) * 100}%` }} />
        </div>
      </div>
      <PriceFormula round={round} />
      {round.bids.length === 0 ? (
        <p className="text-sm text-muted">{round.outcome ?? "No company is offered this window. The house ad plays."}</p>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Leaderboard order={order} />
          <Graph order={order} />
        </div>
      )}
    </div>
  );
}

function Closed({ round }: { round: Round }) {
  const order = ranked(round.bids);
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-md border border-line bg-ink p-3 text-sm">{round.outcome}</p>
      {order.length > 0 && <Leaderboard order={order} />}
    </div>
  );
}

function PriceFormula({ round }: { round: Round }) {
  const p = round.pricing;
  if (!p) return null;
  const cap = Math.max(round.floorMinor, Math.round(p.capMultiplier * Math.max(p.predictedMinor, round.floorMinor)));
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Term label="Predicted" value={money(p.predictedMinor)} hint={p.modelId ? "price model" : "recent average (no model yet)"} weight={`× ${p.a}`} />
      <span className="text-faint">+</span>
      <Term label="People in view" value={p.people === null ? "–" : String(p.people)} hint={p.people === null ? "no camera" : "camera CNN"} weight={`× ${p.b}¢`} />
      <span className="text-faint">+</span>
      <Term label="Brand value" value="0–1" hint="per company, from research" weight={`× ${p.c}¢`} />
      <span className="text-faint">→</span>
      <Term label="Clamped to" value={`${money(round.floorMinor)}–${money(cap)}`} hint={`cap ${p.capMultiplier}× predicted`} />
    </div>
  );
}

function Term({ label, value, hint, weight }: { label: string; value: string; hint: string; weight?: string }) {
  return (
    <div className="flex flex-col rounded-md border border-line px-3 py-1.5">
      <span className="text-[11px] tracking-wider text-faint uppercase">{label}</span>
      <span className="tabular font-mono text-fg">
        {value} {weight && <span className="text-muted">{weight}</span>}
      </span>
      <span className="text-[11px] text-faint">{hint}</span>
    </div>
  );
}

/** Rows sit at their rank's height and slide when the ranking changes. */
function Leaderboard({ order }: { order: Bid[] }) {
  const rankOf = new Map(order.map((b, i) => [b.advertiserId, i]));
  const byName = [...order].sort((a, b) => a.company.localeCompare(b.company));
  return (
    <div>
      <p className="mb-2 text-xs tracking-widest text-muted uppercase">Leaderboard</p>
      <ol className="relative" style={{ height: order.length * ROW_H }} aria-label="Leaderboard">
        {byName.map((b) => {
          const rank = rankOf.get(b.advertiserId) ?? 0;
          const s = STATE[b.status];
          const { value, tier } = standing(b);
          const lead = rank === 0 && tier <= 2;
          return (
            <li
              key={b.advertiserId}
              className={`absolute inset-x-0 flex items-center gap-3 rounded-md border px-3 transition-transform duration-500 ease-out ${lead ? "border-emerald-400 bg-emerald-400/10" : "border-line bg-ink"}`}
              style={{ height: ROW_H - 6, transform: `translateY(${rank * ROW_H}px)` }}
            >
              <span className="tabular w-6 font-mono text-sm text-faint">{rank + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <strong className="truncate text-sm">{b.company}</strong>
                  <Pill tone={s.tone}>{b.status === "invited" && b.amountMinor !== null ? "Countered" : s.label}</Pill>
                </div>
                <p className="truncate text-xs text-muted" title={b.reasoning ?? undefined}>
                  {b.reasoning ?? `Offered ${money(b.offerMinor ?? 0)}${b.match !== null ? ` · ${Math.round(b.match * 100)}% of the crowd are its buyers` : ""}`}
                </p>
              </div>
              <span className={`tabular font-mono text-lg ${value === null ? "text-faint" : "text-fg"}`}>{value === null ? "…" : money(value)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * BillboardOS on the left, each company on the right in rank order. The top
 * edge is the host's price to that company, the bottom edge the company's
 * latest answer back.
 */
function Graph({ order }: { order: Bid[] }) {
  const n = order.length;
  const W = 560;
  const H = Math.max(160, n * ROW_H);
  const hostX = 70;
  const coX = 420;
  const midX = (hostX + coX) / 2;
  const rankOf = new Map(order.map((b, i) => [b.advertiserId, i]));
  const yOf = (rank: number) => rank * ROW_H + ROW_H / 2;
  const hostY = H / 2;
  const byName = [...order].sort((a, b) => a.company.localeCompare(b.company));
  return (
    <div className="min-w-0">
      <p className="mb-2 text-xs tracking-widest text-muted uppercase">Negotiations</p>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[420px]" role="img" aria-label="Offers from BillboardOS and each company's answer">
          {byName.map((b) => {
            const y = yOf(rankOf.get(b.advertiserId) ?? 0);
            const agreed = b.status === "bid" || b.status === "won";
            const passed = b.status === "passed" || b.status === "lost" || b.status === "defaulted";
            const answer = b.status === "passed" ? "pass" : b.amountMinor === null ? "…" : money(b.amountMinor);
            const back = agreed ? "var(--color-ok)" : passed ? "var(--color-line)" : b.amountMinor !== null ? "#f0a54a" : "var(--color-line)";
            return (
              <g key={b.advertiserId}>
                <path
                  d={`M ${hostX + 34} ${hostY - 6} C ${midX} ${hostY - 6}, ${midX} ${y - 10}, ${coX - 8} ${y - 10}`}
                  fill="none"
                  stroke="var(--color-info)"
                  strokeWidth={1.5}
                  opacity={0.8}
                  style={{ transition: "d 500ms ease-out" }}
                />
                <path
                  d={`M ${coX - 8} ${y + 10} C ${midX} ${y + 10}, ${midX} ${hostY + 6}, ${hostX + 34} ${hostY + 6}`}
                  fill="none"
                  stroke={back}
                  strokeWidth={agreed ? 2.5 : 1.5}
                  strokeDasharray={passed || b.amountMinor === null ? "4 4" : undefined}
                  style={{ transition: "d 500ms ease-out" }}
                />
                <g style={{ transform: `translateY(${y}px)`, transition: "transform 500ms ease-out" }}>
                  <text x={midX + 30} y={-16} fontSize={12} fill="var(--color-info)" className="tabular font-mono">
                    {money(b.offerMinor ?? 0)}
                  </text>
                  <text x={midX + 30} y={24} fontSize={12} fill={agreed ? "var(--color-ok)" : "var(--color-muted)"} className="tabular font-mono">
                    {answer}
                  </text>
                  <circle cx={coX} cy={0} r={7} fill={agreed ? "var(--color-ok)" : passed ? "var(--color-line)" : "var(--color-accent)"} />
                  <text x={coX + 14} y={4} fontSize={13} fill="var(--color-fg)">
                    {b.company}
                  </text>
                </g>
              </g>
            );
          })}
          <circle cx={hostX} cy={hostY} r={30} fill="var(--color-raised)" stroke="var(--color-accent)" strokeWidth={2} />
          <text x={hostX} y={hostY + 4} fontSize={11} textAnchor="middle" fill="var(--color-fg)" fontWeight={600}>
            BillboardOS
          </text>
        </svg>
      </div>
      <p className="mt-1 flex flex-wrap gap-4 text-[11px] text-faint">
        <span>Top edge: our price to them</span>
        <span>Bottom edge: their answer (green agreed, amber countered, dashed waiting or passed)</span>
      </p>
    </div>
  );
}
