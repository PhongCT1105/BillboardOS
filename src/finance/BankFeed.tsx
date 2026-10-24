import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { money, shortDate, words } from "../lib/format";

type Line = FunctionReturnType<typeof api.finance.bankFeed>[number];

const STATUS_STYLE: Record<Line["status"], string> = {
  unmatched: "text-muted",
  matched: "text-fg",
  partially_applied: "text-accent",
  needs_review: "text-danger",
};

export function BankFeed({ lines }: { lines: Line[] | undefined }) {
  const simulated = lines?.some((l) => l.source === "fixture");
  return (
    <section aria-labelledby="bank-heading">
      <h2 id="bank-heading" className="text-lg font-semibold">
        Bank feed
      </h2>
      {simulated && <p className="mt-1 text-sm text-muted">Includes simulated bank lines with planted errors.</p>}
      {lines === undefined ? (
        <div className="mt-4 h-48 animate-pulse rounded bg-panel" />
      ) : lines.length === 0 ? (
        <p className="mt-3 text-muted">No bank lines yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-line border-y border-line">
          {lines.map((line) => (
            <li key={line._id} className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{line.payerName}</p>
                <p className="truncate font-mono text-xs text-faint">
                  {shortDate(line.postedAt)}, {line.memo || "no memo"}
                </p>
              </div>
              <div className="text-right">
                <p className="tabular font-mono">{money(line.amountMinor)}</p>
                <p className={`text-xs ${STATUS_STYLE[line.status]}`}>{words(line.status)}</p>
              </div>
              {(line.applications.length > 0 || line.note || line.openExceptionKinds.length > 0) && (
                <div className="col-span-2 flex flex-col gap-1 text-sm text-muted">
                  {line.applications.map((a) => (
                    <p key={`${a.invoiceId}-${a.rule}`}>
                      Applied <span className="tabular font-mono text-fg">{money(a.amountMinor)}</span> to {a.invoiceNumber} by{" "}
                      {a.appliedBy}, rule {words(a.rule)}
                    </p>
                  ))}
                  {line.note && <p>{line.note}</p>}
                  {line.openExceptionKinds.length > 0 && (
                    <p className="text-danger">Open: {line.openExceptionKinds.map(words).join(", ")}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
