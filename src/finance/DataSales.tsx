import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ago, money, txUrl } from "../lib/format";
import { useNow } from "../lib/hooks";

/** Data-product revenue (ADR 0005): audience reports sold by the seller agent over x402. Its own revenue line. */
export function DataSales() {
  const sales = useQuery(api.a2a.dataSalesForWorkspace, {});
  const now = useNow(60_000);
  return (
    <section aria-labelledby="data-sales-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="data-sales-heading" className="text-lg font-semibold">
          Data sales
        </h2>
        {sales && (
          <p className="text-sm text-muted">
            Report revenue <span className="tabular font-mono text-fg">{money(sales.totalMinor)}</span> from {sales.count}
            {sales.capped ? "+" : ""} sale{sales.count === 1 ? "" : "s"}
          </p>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">Audience reports your seller agent sold to buyer agents, settled in USDC over x402. Separate from airtime receivables.</p>
      {sales === undefined ? (
        <div className="mt-4 h-24 animate-pulse rounded bg-panel" />
      ) : sales.recent.length === 0 ? (
        <p className="mt-3 text-muted">No reports sold yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-lg border border-line">
          {sales.recent.map((s) => {
            const url = txUrl(s.network, s.txHash);
            return (
              <li key={s.dataSaleId} className="flex flex-wrap items-baseline justify-between gap-3 bg-panel px-4 py-2.5 text-sm">
                <span>
                  {s.companyName} <span className="text-muted">· {s.billboardName} audience report · {ago(s.recordedAt, now)}</span>
                </span>
                <span className="flex items-baseline gap-3">
                  <span className="tabular font-mono">{money(s.amountMinor)}</span>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent underline-offset-4 hover:underline">
                      {s.txHash.slice(0, 8)}…
                    </a>
                  ) : (
                    <span className="font-mono text-xs text-faint">{s.txHash.slice(0, 8)}…</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
