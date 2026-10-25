import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { money } from "../lib/format";
import { useNow } from "../lib/hooks";
import { Card, ErrorLine, Pill, primaryBtn, secondaryBtn, useAction } from "../customer/ui";

type Live = FunctionReturnType<typeof api.rounds.live>;
type Round = NonNullable<Live["screens"][number]["round"]>;
type Bid = Round["bids"][number];

const STATUS: Record<Round["status"], { label: string; tone: "accent" | "danger" | "muted" | "ok" }> = {
  bidding: { label: "Bidding", tone: "accent" },
  awarded: { label: "Winner paying", tone: "accent" },
  paid: { label: "Paid", tone: "ok" },
  unsold: { label: "Unsold", tone: "muted" },
};

const TRIGGER: Record<Round["trigger"], string> = { camera: "camera", sell_now: "Sell now", timer: "auto-sell" };

/**
 * The bidding round on one screen (spec: simple bidding rounds): Sell now,
 * the asking price with each signal's reason, every agent's sealed answer
 * with its reasoning as it arrives, the outcome sentence and the payment.
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

  async function start() {
    setNote(null);
    const r = await sell.run(() => sellNow({ billboardId }));
    if (r?.reason) setNote(r.reason);
  }

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Bidding round</h2>
          <p className="text-sm text-muted">Every company agent with an approved ad gets one sealed bid. It closes as soon as all have answered, or after 5 s.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted" title="Starts a round on idle online screens every couple of minutes. Each sale spends testnet USDC.">
            <input
              type="checkbox"
              checked={live.autoSell}
              disabled={toggle.busy}
              onChange={(e) => toggle.run(() => setAutoSell({ enabled: e.target.checked }))}
              className="h-4 w-4 accent-accent"
            />
            Auto-sell when idle
          </label>
          <button type="button" className={`${primaryBtn} min-h-11`} disabled={sell.busy || round?.status === "bidding" || round?.status === "awarded"} onClick={start}>
            {sell.busy ? "Starting…" : "Sell now"}
          </button>
        </div>
      </div>
      <ErrorLine error={sell.error ?? toggle.error} />
      {note && <p className="text-sm text-amber-300">{note}</p>}

      {!round ? (
        <p className="text-sm text-muted">No round yet on this screen. Press Sell now, or let the camera start one when people walk up.</p>
      ) : (
        <RoundDetail round={round} now={now} />
      )}
    </Card>
  );
}

function RoundDetail({ round, now }: { round: Round; now: number }) {
  const status = STATUS[round.status];
  const left = Math.max(0, Math.ceil((round.closesAt - now) / 1000));
  const bids = [...round.bids].sort((a, b) => (b.amountMinor ?? -1) - (a.amountMinor ?? -1));
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Pill tone={status.tone}>{status.label}</Pill>
            <span className="text-xs text-faint">started by {TRIGGER[round.trigger]}</span>
          </div>
          <p className="text-sm text-muted">
            Floor <span className="tabular font-mono text-fg">{money(round.floorMinor)}</span> · asking{" "}
            <span className="tabular font-mono text-fg">{money(round.askingMinor)}</span>
          </p>
        </div>
        {round.status === "bidding" && (
          <p className="tabular font-mono text-3xl font-semibold text-accent" aria-live="polite">
            {left}s
          </p>
        )}
      </div>

      <ul className="flex flex-col gap-1 text-[13px] text-muted" aria-label="Price signals">
        {round.signals.map((s) => (
          <li key={s.key} className={s.factor === null ? "text-faint" : ""}>
            {s.reason}
          </li>
        ))}
      </ul>

      <ol className="flex flex-col gap-2" aria-label="Bids" aria-live="polite">
        {bids.length === 0 && <li className="text-sm text-faint">No company agents invited.</li>}
        {bids.map((b, i) => (
          <BidRow key={`${b.company}-${i}`} bid={b} />
        ))}
      </ol>

      {round.outcome && <p className="rounded-md border border-line bg-ink p-3 text-sm text-fg">{round.outcome}</p>}
      {round.txUrl && (
        <a href={round.txUrl} target="_blank" rel="noreferrer" className={`${secondaryBtn} self-start`}>
          View the x402 payment on Basescan
        </a>
      )}
    </div>
  );
}

function BidRow({ bid }: { bid: Bid }) {
  const amount =
    bid.status === "invited" ? "waiting…" : bid.amountMinor === null ? "passed" : money(bid.amountMinor);
  const tone =
    bid.status === "won" ? "border-emerald-400 bg-emerald-400/10" : bid.status === "defaulted" ? "border-danger bg-danger/10" : "border-line";
  return (
    <li className={`flex flex-col gap-1 rounded-md border p-3 ${tone}`}>
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm">{bid.company}</strong>
        <span className={`tabular font-mono text-sm ${bid.amountMinor === null ? "text-faint" : "text-fg"}`}>{amount}</span>
      </div>
      <p className="text-xs text-muted">
        {bid.reasoning ?? (bid.status === "invited" ? "Thinking…" : "")}
        {bid.match !== null && <span className="text-faint"> · {Math.round(bid.match * 100)}% audience match</span>}
        {bid.status === "won" && <span className="text-emerald-300"> · won</span>}
        {bid.status === "defaulted" && <span className="text-danger"> · didn't pay</span>}
      </p>
    </li>
  );
}
