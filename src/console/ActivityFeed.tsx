import type { Doc } from "../../convex/_generated/dataModel";
import { ago } from "../lib/format";
import { useNow } from "../lib/hooks";

export function ActivityFeed({ events }: { events: Doc<"auditEvents">[] | undefined }) {
  const now = useNow(15_000);
  return (
    <section aria-labelledby="activity-heading" className="lg:sticky lg:top-6 lg:self-start">
      <h2 id="activity-heading" className="text-lg font-semibold">
        Activity
      </h2>
      <p className="mt-1 text-sm text-muted">Every state change, who made it and why.</p>
      {events === undefined ? (
        <div className="mt-4 h-80 animate-pulse rounded bg-panel" />
      ) : events.length === 0 ? (
        <p className="mt-4 text-muted">No activity yet.</p>
      ) : (
        <ol className="mt-4 flex max-h-[70dvh] flex-col gap-4 overflow-y-auto pr-1">
          {events.map((e) => (
            <li key={e._id} className="fade-in border-l-2 border-line pl-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-xs text-fg">{e.type}</span>
                <span className="shrink-0 text-xs text-faint">{ago(e._creationTime, now)}</span>
              </div>
              <p className="mt-0.5 text-sm text-muted">{e.reason}</p>
              <p className="mt-0.5 text-xs text-faint">{e.actor}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
