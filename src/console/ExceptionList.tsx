import type { Doc } from "../../convex/_generated/dataModel";
import { money } from "../lib/format";

const KIND_LABEL: Record<Doc<"financeExceptions">["kind"], string> = {
  payment_after_hold_expired: "Payment arrived after the hold expired",
  amount_mismatch: "Payment amount does not match the quote",
  asset_mismatch: "Payment asset does not match the quote currency",
  duplicate_payment: "Second payment for an already booked hold",
};

export function ExceptionList({ exceptions }: { exceptions: Doc<"financeExceptions">[] | undefined }) {
  return (
    <section aria-labelledby="exceptions-heading">
      <h2 id="exceptions-heading" className="text-lg font-semibold">
        Finance exceptions
      </h2>
      {exceptions === undefined ? (
        <div className="mt-4 h-24 animate-pulse rounded bg-panel" />
      ) : exceptions.length === 0 ? (
        <p className="mt-3 text-muted">Nothing needs review. Every payment matched a live hold.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">
          {exceptions.map((ex) => {
            const diff = ex.observedMinor - ex.expectedMinor;
            return (
              <li key={ex._id} className="fade-in rounded-lg border border-danger/50 bg-panel p-4">
                <p className="font-medium text-danger">{KIND_LABEL[ex.kind]}</p>
                <dl className="mt-3 grid grid-cols-3 gap-4 text-sm">
                  <Figure label="Expected" value={money(ex.expectedMinor)} />
                  <Figure label="Observed" value={money(ex.observedMinor)} />
                  <Figure label="Difference" value={`${diff > 0 ? "+" : ""}${money(diff)}`} />
                </dl>
                <p className="mt-3 text-sm text-muted">{ex.evidence}</p>
                <p className="mt-2 text-sm">
                  <span className="text-muted">Next action: </span>
                  {ex.nextAction}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Figure(props: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{props.label}</dt>
      <dd className="tabular font-mono">{props.value}</dd>
    </div>
  );
}
