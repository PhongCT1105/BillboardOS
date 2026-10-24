import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { money, shortDate, words } from "../lib/format";

type Invoice = FunctionReturnType<typeof api.finance.receivables>[number];

export function Receivables({ invoices }: { invoices: Invoice[] | undefined }) {
  return (
    <section aria-labelledby="receivables-heading">
      <h2 id="receivables-heading" className="text-lg font-semibold">
        Open receivables
      </h2>
      {invoices === undefined ? (
        <div className="mt-4 h-40 animate-pulse rounded bg-panel" />
      ) : invoices.length === 0 ? (
        <p className="mt-3 text-muted">Every invoice is paid.</p>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {invoices.map((inv) => (
            <li key={inv.invoiceId} className="rounded-lg border border-line bg-panel p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-sm">{inv.number}</span>
                <span className={`text-xs ${inv.daysOverdue > 0 ? "text-danger" : "text-muted"}`}>
                  {inv.daysOverdue > 0 ? `${inv.daysOverdue} days overdue` : `due ${shortDate(inv.dueAt)}`}
                </span>
              </div>
              <p className="mt-1 truncate font-medium">{inv.advertiserName}</p>
              <div className="mt-2 flex items-baseline justify-between gap-3">
                <span className="tabular font-mono text-xl">{money(inv.balanceMinor)}</span>
                <span className="text-xs text-muted">
                  {words(inv.status)}
                  {inv.balanceMinor !== inv.amountMinor && `, of ${money(inv.amountMinor)}`}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
