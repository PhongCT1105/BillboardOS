import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ago, money } from "../lib/format";
import { useNow } from "../lib/hooks";

const MINUTE = 60_000;

const KIND_LABEL: Record<string, string> = {
  offer: "Offered",
  reprice: "Re-priced",
  accepted: "Booked",
  interest: "Interest",
  auction: "Auction",
  expired: "Expired",
  withdrawn: "Withdrawn",
  handoff: "To live auction",
  paused: "Paused",
  resumed: "Resumed",
  sell_now: "Sell now",
  plan: "Plan",
};

/**
 * Host console, top: what the seller agent is doing for the next 12 hours,
 * what's booked ahead, unsold hours at risk and its latest reasoning (live).
 */
export function AutopilotPanel() {
  const minute = Math.floor(useNow(30_000) / MINUTE) * MINUTE;
  const now = useNow(15_000);
  const status = useQuery(api.autopilot.status, { atMinute: minute });

  if (status === undefined) {
    return <div className="h-48 animate-pulse rounded-lg bg-panel" aria-label="Loading the autopilot" />;
  }

  const planned = status.lastPlanAt !== null ? `planned ${ago(status.lastPlanAt, now)}` : "first plan within a minute";
  return (
    <section aria-labelledby="autopilot-heading" className="fade-in rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line p-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="autopilot-heading" className="text-lg font-semibold tracking-tight">
              Autopilot
            </h2>
            {status.enabled ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-ok/60 px-2 py-0.5 text-xs font-medium text-ok">
                <span className="size-1.5 animate-pulse rounded-full bg-ok" aria-hidden />
                On
              </span>
            ) : (
              <span className="rounded-full border border-danger/60 px-2 py-0.5 text-xs font-medium text-danger">Paused</span>
            )}
            <span className="text-xs text-faint">{status.enabled ? planned : ""}</span>
          </div>
          <p className="mt-2 max-w-[80ch] text-sm text-fg">{status.doing}</p>
        </div>
        <a href="#/workspace" className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
          {status.canChange ? "Pause or sell a slot now" : "Settings"}
        </a>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-line p-5 md:grid-cols-4">
        <Stat label="Booked ahead (12 h)" value={`${status.bookedAhead.slots} slot${status.bookedAhead.slots === 1 ? "" : "s"}`} sub={money(status.bookedAhead.amountMinor)} />
        <Stat
          label="Unsold, next 2 h"
          value={`${status.atRisk.hours.toFixed(2).replace(/\.?0+$/, "")} h`}
          sub={`${status.atRisk.slots} slot${status.atRisk.slots === 1 ? "" : "s"} at risk`}
          tone={status.atRisk.slots > 0 ? "warn" : undefined}
        />
        <Stat label="Offers out" value={String(status.openOffers.ahead + status.openOffers.early)} sub={`${status.openOffers.ahead} within 2 h · ${status.openOffers.early} later`} />
        <Stat label="Company agents offered" value={String(status.companies)} sub={status.openOffers.firstLooks > 0 ? `${status.openOffers.firstLooks} deciding now` : "profile, reach and limits fit"} />
      </dl>

      <div className="p-5">
        <h3 className="text-sm font-medium text-muted">Latest reasoning</h3>
        {status.log.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing yet. The seller agent plans every minute and writes down each decision here.</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-2.5" aria-live="polite">
            {status.log.map((l) => (
              <li key={l._id} className="fade-in grid grid-cols-[92px_minmax(0,1fr)_auto] items-baseline gap-3 text-sm">
                <span className={`text-xs font-medium ${l.kind === "accepted" ? "text-ok" : l.kind === "auction" ? "text-accent" : l.kind === "paused" ? "text-danger" : "text-muted"}`}>
                  {KIND_LABEL[l.kind] ?? l.kind}
                </span>
                <span className="text-fg">{l.text}</span>
                <span className="shrink-0 text-xs text-faint">{ago(l.at, now)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function Stat(props: { label: string; value: string; sub: string; tone?: "warn" }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted">{props.label}</dt>
      <dd className={`tabular font-mono text-2xl ${props.tone === "warn" ? "text-accent" : ""}`}>{props.value}</dd>
      <dd className="text-xs text-faint">{props.sub}</dd>
    </div>
  );
}
