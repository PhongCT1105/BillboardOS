import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { money } from "../lib/format";
import { Card, ErrorLine, Pill, primaryBtn, useAction } from "../customer/ui";

const STATUS = {
  bidding: { label: "Negotiating", tone: "accent" },
  awarded: { label: "Buyer paying", tone: "accent" },
  paid: { label: "Paid", tone: "ok" },
  unsold: { label: "Unsold", tone: "muted" },
} as const;

/**
 * Host dashboard: each screen's latest live sale with Sell now, and the
 * auto-sell switch (on by default: an unsold spot on air starts a round).
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

  return (
    <section aria-labelledby="live-sales-heading" className="flex flex-col gap-3">
      <div className="demo-section-heading">
        <div>
          <h2 id="live-sales-heading">Live sales</h2>
          <p>Every company agent gets the same offer for the spot on air. The first to agree takes it. Unsold spots are offered on their own.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted" title="Starts a round when an online screen's spot on air is unsold. Each company's daily budget caps what it spends.">
          <input
            type="checkbox"
            checked={live.autoSell}
            disabled={toggle.busy}
            onChange={(e) => toggle.run(() => setAutoSell({ enabled: e.target.checked }))}
            className="h-4 w-4 accent-accent"
          />
          Auto-sell
        </label>
      </div>
      <ErrorLine error={sell.error ?? toggle.error} />
      {note && <p className="text-sm text-amber-300">{note}</p>}
      {live.screens.map((s) => {
        const round = s.round;
        const open = round?.status === "bidding" || round?.status === "awarded";
        return (
          <Card key={s.billboardId} className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.name}</span>
                {round ? <Pill tone={STATUS[round.status].tone}>{STATUS[round.status].label}</Pill> : <Pill tone="muted">No round yet</Pill>}
                {!s.online && <span className="text-xs text-faint">offline</span>}
              </div>
              <p className="text-sm text-muted">
                {round ? (round.outcome ?? `Offered at ${money(round.askingMinor)} to ${round.bids.length} ${round.bids.length === 1 ? "company" : "companies"}`) : "A round starts when the spot on air is unsold, or press Sell now."}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <a href="#/moment" className="text-sm text-muted hover:text-fg">
                Details
              </a>
              <button type="button" className={`${primaryBtn} min-h-11`} disabled={sell.busy || open} onClick={() => start(s.billboardId)}>
                Sell now
              </button>
            </div>
          </Card>
        );
      })}
    </section>
  );
}
