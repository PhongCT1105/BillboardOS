import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { ExceptionList } from "../console/ExceptionList";
import { errorMessage } from "../lib/format";
import { BankFeed } from "./BankFeed";
import { Receivables } from "./Receivables";
import { ApprovalQueue } from "./ApprovalQueue";
import { CollectionTasks } from "./CollectionTasks";
import { CompanyValuations } from "./CompanyValuations";

type RunSummary = FunctionReturnType<typeof api.finance.runReconciliation>;

export function FinancePage() {
  const bankFeed = useQuery(api.finance.bankFeed, {});
  const receivables = useQuery(api.finance.receivables, {});
  const exceptions = useQuery(api.finance.openExceptions, {});
  const approvals = useQuery(api.approvals.pending, {});
  const tasks = useQuery(api.collections.tasks, {});
  const runReconciliation = useMutation(api.finance.runReconciliation);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unmatched = bankFeed?.filter((l) => l.status === "unmatched").length ?? 0;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setSummary(await runReconciliation({}));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-[1400px] px-4 pb-16 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4 pt-8 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Finance</h1>
          <p className="mt-1 max-w-[65ch] text-sm text-muted">
            The AR clerk applies bank payments to invoices. The collections agent plans follow-ups. Refunds, write-offs and
            escalations wait for you.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted">{unmatched} bank line{unmatched === 1 ? "" : "s"} waiting</span>
          <button
            type="button"
            onClick={run}
            disabled={busy || unmatched === 0}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-transform active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? "Reconciling" : "Run reconciliation"}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-6 text-sm text-danger">
          {error}
        </p>
      )}
      {summary && <RunResult summary={summary} />}

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex flex-col gap-10">
          <BankFeed lines={bankFeed} />
          <ExceptionList exceptions={exceptions} />
          <Receivables invoices={receivables} />
          <CompanyValuations />
        </div>
        <div className="flex flex-col gap-10 lg:sticky lg:top-6 lg:self-start">
          <ApprovalQueue approvals={approvals} />
          <CollectionTasks tasks={tasks} />
        </div>
      </div>
    </main>
  );
}

function RunResult({ summary }: { summary: RunSummary }) {
  const figures: [string, number][] = [
    ["Processed", summary.processed],
    ["Matched", summary.matched],
    ["Partially applied", summary.partiallyApplied],
    ["Needs review", summary.needsReview],
    ["Exceptions opened", summary.exceptionsOpened],
    ["Approvals requested", summary.approvalsRequested],
  ];
  return (
    <section aria-label="Reconciliation result" className="fade-in mb-10 border-y border-line py-5">
      <dl className="grid grid-cols-3 gap-6 md:grid-cols-6">
        {figures.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="tabular font-mono text-2xl">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
