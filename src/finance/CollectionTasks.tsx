import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { money, words } from "../lib/format";

type Task = FunctionReturnType<typeof api.collections.tasks>[number];

const TONE_STYLE: Record<Task["tone"], string> = {
  friendly: "text-muted",
  firm: "text-accent",
  escalate_to_controller: "text-danger",
};

export function CollectionTasks({ tasks }: { tasks: Task[] | undefined }) {
  const open = tasks?.filter((t) => t.status !== "resolved");
  return (
    <section aria-labelledby="collections-heading">
      <h2 id="collections-heading" className="text-lg font-semibold">
        Collections plan
      </h2>
      <p className="mt-1 text-sm text-muted">Tone follows each payer's history. Nothing is sent without you.</p>
      {open === undefined ? (
        <div className="mt-4 h-32 animate-pulse rounded bg-panel" />
      ) : open.length === 0 ? (
        <p className="mt-4 text-muted">No overdue invoices to chase.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">
          {open.map((t) => (
            <li key={t._id} className="border-l-2 border-line pl-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">
                  {t.advertiserName}, <span className="font-mono text-sm">{t.invoiceNumber}</span>
                </span>
                <span className={`text-xs ${TONE_STYLE[t.tone]}`}>{words(t.tone)}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{t.reason}</p>
              <p className="mt-1 text-xs text-faint">
                {money(t.balanceMinor)} outstanding, {t.daysOverdue} days overdue
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
