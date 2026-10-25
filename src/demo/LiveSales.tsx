import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { money } from "../lib/format";
import { ErrorLine, useAction } from "../customer/ui";
import { ArrowRight, CheckCircle, Circle } from "@phosphor-icons/react";
import { ago } from "../lib/format";
import { useNow } from "../lib/hooks";

const STATUS = {
  bidding: { label: "Negotiating", tone: "accent" },
  awarded: { label: "Buyer paying", tone: "accent" },
  paid: { label: "Paid", tone: "ok" },
  unsold: { label: "Unsold", tone: "muted" },
} as const;

type LiveScreen = FunctionReturnType<typeof api.rounds.live>["screens"][number];
export type LiveSalesData = {
  autoSell: boolean;
  screens: (Pick<LiveScreen, "billboardId" | "name" | "online"> & {
    round: (Pick<NonNullable<LiveScreen["round"]>, "status" | "outcome" | "bids" | "askingMinor"> & Partial<Pick<NonNullable<LiveScreen["round"]>, "winner" | "priceMinor" | "spotStartAt">>) | null;
  })[];
};

/**
 * Host dashboard: each screen's latest live sale with Sell now, and the
 * auto-sell switch (on by default: the 30-second selling loop runs on every online screen).
 */
export function LiveSales() {
  const live = useQuery(api.rounds.live, {});
  const sellNow = useMutation(api.rounds.sellNow);
  const setAutoSell = useMutation(api.rounds.setAutoSell);
  const sell = useAction();
  const toggle = useAction();
  const [note, setNote] = useState<string | null>(null);

  if (live === undefined || live.screens.length === 0) return null;

  async function start(billboardId: Id<"billboards">) {
    setNote(null);
    const r = await sell.run(() => sellNow({ billboardId }));
    if (r?.reason) setNote(r.reason);
  }

  return <LiveSalesPanel live={live} onSell={start} onToggle={(enabled) => { void toggle.run(() => setAutoSell({ enabled })); }} selling={sell.busy} toggling={toggle.busy} error={sell.error ?? toggle.error} note={note} />;
}

export function LiveSalesPanel({ live, onSell, onToggle, selling = false, toggling = false, error = null, note = null, sample = false }: {
  live: LiveSalesData;
  onSell: (billboardId: Id<"billboards">) => void;
  onToggle: (enabled: boolean) => void;
  selling?: boolean;
  toggling?: boolean;
  error?: string | null;
  note?: string | null;
  sample?: boolean;
}) {
  const now = useNow(10000);
  const [showLog, setShowLog] = useState(false);
  return (
    <section aria-labelledby="live-sales-heading" className="sales-feed">
      <div className="sales-heading">
        <h2 id="live-sales-heading"><Circle size={11} weight="fill" />Live Sales</h2>
        <span className="sales-mode">{live.autoSell ? "Auto-sell Active" : "Auto-sell Off"}</span>
      </div>
      <div className="sales-control">
        <label className="dashboard-switch" title="Automatically sell 30-second slots on online displays">
          <span>Auto-sell</span>
          <input
            type="checkbox"
            role="switch"
            checked={live.autoSell}
            disabled={toggling}
            onChange={(e) => onToggle(e.target.checked)}
          />
        </label>
      </div>
      <ErrorLine error={error} />
      {note && <p role="status" className="text-sm text-muted">{note}</p>}
      <div className="sales-entries">
      {live.screens.map((s) => {
        const round = s.round;
        const open = round?.status === "bidding" || round?.status === "awarded";
        return (
          <div key={s.billboardId} className="sales-entry">
            <div className="sales-entry-top"><strong>{round?.winner ?? s.name}</strong>{round?.priceMinor != null && <strong>{round.status === "paid" ? "+" : ""}{money(round.priceMinor)}</strong>}</div>
            <div className="sales-entry-meta"><span>{s.name}</span>{round?.spotStartAt != null && round.spotStartAt <= now && <time dateTime={new Date(round.spotStartAt).toISOString()}>{ago(round.spotStartAt, now)}</time>}</div>
            <div className="sales-entry-bottom"><span className={round?.status === "paid" ? "status-online" : "text-muted"}>{round?.status === "paid" && <CheckCircle size={13} />}{round ? STATUS[round.status].label : "No sale yet"}{!s.online ? " · Display offline" : ""}</span>
              <button type="button" className="sale-action" disabled={selling || open} onClick={() => onSell(s.billboardId)}>
                {selling ? "Starting…" : open ? "In progress" : "Sell now"}
              </button>
            </div>
            {round?.outcome && <details className="sale-outcome"><summary>Sale details</summary><p>{round.outcome}</p></details>}
          </div>
        );
      })}
      </div>
      <div className="sales-total"><div><span>Current paid rounds</span><strong>{money(live.screens.reduce((sum, s) => sum + (s.round?.status === "paid" ? s.round.priceMinor ?? 0 : 0), 0))}</strong></div><ArrowRight size={20} /></div>
      {sample ? <><button className="sales-log-link" onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>View Sales Log</button>{showLog && <p className="sample-data-label">Sample transactions only. No payments were processed.</p>}</> : <a className="sales-log-link" href="#/moment">View Sales Log</a>}
    </section>
  );
}
