import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { money } from "../lib/format";
import { Sparkline } from "./Sparkline";

type Summary = FunctionReturnType<typeof api.dashboard.summary>["billboards"][number];
type Audience = FunctionReturnType<typeof api.audience.recentForBillboard>;

export function KpiStrip(props: { summary: Summary | undefined; audience: Audience | undefined }) {
  const s = props.summary;
  const latest = props.audience?.at(-1);
  const counts = s?.slotCounts;

  return (
    <section
      aria-label="Key figures"
      className="grid grid-cols-2 gap-x-6 gap-y-6 border-y border-line py-6 md:grid-cols-5"
    >
      <Kpi label="Confirmed revenue" value={s ? money(s.confirmedRevenueMinor) : undefined} />
      <Kpi label="Held now" value={counts ? String(counts.held) : undefined} />
      <Kpi
        label="Booked or scheduled"
        value={counts ? String(counts.booked + counts.scheduled) : undefined}
      />
      <Kpi
        label="Open exceptions"
        value={s ? String(s.openExceptions) : undefined}
        tone={s && s.openExceptions > 0 ? "danger" : undefined}
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">Audience, last 15 min</span>
        <div className="flex items-end gap-3">
          <span className="tabular font-mono text-2xl">{latest ? latest.countEstimate : "None"}</span>
          {latest && (
            <span className="pb-1 text-xs text-faint">{latest.source === "simulated" ? "simulated" : "camera"}</span>
          )}
        </div>
        {props.audience && props.audience.length > 1 && (
          <Sparkline values={props.audience.map((a) => a.countEstimate)} />
        )}
      </div>
    </section>
  );
}

function Kpi(props: { label: string; value: string | undefined; tone?: "danger" }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{props.label}</span>
      {props.value === undefined ? (
        <span className="h-8 w-20 animate-pulse rounded bg-panel" />
      ) : (
        <span className={`tabular font-mono text-2xl ${props.tone === "danger" ? "text-danger" : ""}`}>
          {props.value}
        </span>
      )}
    </div>
  );
}
