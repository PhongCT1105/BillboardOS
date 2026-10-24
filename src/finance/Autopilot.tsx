import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { ago, countdown } from "../lib/format";
import { useNow } from "../lib/hooks";

type Status = FunctionReturnType<typeof api.financeAutopilot.status>;
type Activity = Status["activity"][number];

function nextCheck(status: Status, now: number): string {
  const pending = status.pendingRunAt;
  if (pending !== null && pending > now - status.stalePendingMs) {
    return pending <= now ? "running now" : `next run in ${countdown(pending, now)}`;
  }
  if (status.lastTickAt === null) return "next check within 5 min";
  const next = status.lastTickAt + status.tickIntervalMs;
  return next > now ? `next check in ${countdown(next, now)}` : "next check any moment";
}

/** "AR clerk: auto" with last run, lines processed and next check; "Reconcile now" for the owner. */
export function ArClerkStatus({
  status,
  waiting,
  busy,
  onReconcileNow,
}: {
  status: Status | undefined;
  waiting: number;
  busy: boolean;
  onReconcileNow: () => void;
}) {
  const now = useNow(1000);
  return (
    <div className="flex flex-col items-start gap-1 md:items-end md:text-right" aria-live="polite">
      <p className="flex items-center gap-2 text-sm font-medium">
        <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
        AR clerk: auto
      </p>
      {status === undefined ? (
        <p className="h-4 w-48 animate-pulse rounded bg-panel" />
      ) : (
        <p className="text-xs text-muted">
          {status.lastRunAt === null
            ? "Hasn't run yet"
            : `Last run ${ago(status.lastRunAt, now)}, ${status.lastProcessed ?? 0} line${status.lastProcessed === 1 ? "" : "s"}`}
          {", "}
          {nextCheck(status, now)}
        </p>
      )}
      <p className="text-xs text-faint">
        Runs on every new bank line. {waiting} line{waiting === 1 ? "" : "s"} waiting.
      </p>
      {status?.canReconcileNow && (
        <button
          type="button"
          onClick={onReconcileNow}
          disabled={busy || waiting === 0}
          className="mt-1 rounded-md border border-line px-3 py-1 text-xs font-medium text-fg transition-transform hover:bg-panel active:scale-[0.98] disabled:opacity-50"
        >
          {busy ? "Reconciling" : "Reconcile now"}
        </button>
      )}
    </div>
  );
}

const ACTOR_LABEL: Record<string, string> = {
  "agent:ar": "AR clerk",
  "agent:collections": "Collections",
};

const TYPE_LABEL: Record<string, string> = {
  "reconciliation.applied": "applied cash",
  "reconciliation.needs_review": "flagged for review",
  "reconciliation.handoff": "handed off",
  "collection.planned": "planned follow-up",
};

const TYPE_STYLE: Record<string, string> = {
  "reconciliation.needs_review": "text-danger",
  "reconciliation.handoff": "text-accent",
};

function actorLabel(actor: string): string {
  return ACTOR_LABEL[actor] ?? actor.replace(/^operator:/, "");
}

/** Compact feed of what the AR clerk and collections seat did on their own. */
export function AutopilotFeed({ activity }: { activity: Activity[] | undefined }) {
  const now = useNow(15_000);
  return (
    <section aria-labelledby="autopilot-heading">
      <h2 id="autopilot-heading" className="text-lg font-semibold">
        Autopilot activity
      </h2>
      <p className="mt-1 text-sm text-muted">What the agents did without a click.</p>
      {activity === undefined ? (
        <div className="mt-4 h-24 animate-pulse rounded bg-panel" />
      ) : activity.length === 0 ? (
        <p className="mt-4 text-muted">Nothing yet. The AR clerk wakes when bank lines arrive.</p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-line border-y border-line">
          {activity.map((e) => (
            <li key={e._id} className="py-2">
              <p className="flex items-baseline justify-between gap-3 text-sm">
                <span>
                  <span className="font-medium">{actorLabel(e.actor)}</span>{" "}
                  <span className={TYPE_STYLE[e.type] ?? "text-muted"}>{TYPE_LABEL[e.type] ?? e.type}</span>
                </span>
                <span className="shrink-0 font-mono text-xs text-faint">{ago(e._creationTime, now)}</span>
              </p>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted" title={e.reason}>
                {e.reason}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
