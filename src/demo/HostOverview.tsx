import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { money } from "../lib/format";
import { ConnectedDisplays } from "../console/ConnectedDisplays";
import { InviteRosterPanel } from "../console/InviteRosterPanel";
import { LeadOutreachPanel } from "../console/LeadOutreachPanel";
import { LiveSales } from "./LiveSales";
import { DashboardSkeleton } from "./ui";
import { ArrowRight, CheckCircle, Warning } from "@phosphor-icons/react";
import { useEffect } from "react";

export function HostOverview({ focusDisplays = false }: { focusDisplays?: boolean }) {
  const screens = useQuery(api.billboards.mine, {});
  const summary = useQuery(api.dashboard.summary, {});
  const live = useQuery(api.rounds.live, {});
  const ready = Boolean(screens && summary);
  const focusScreen = screens?.find((s) => s.deviceStatus === "online") ?? screens?.[0];
  useEffect(() => {
    if (focusDisplays && ready) document.getElementById("connected-displays")?.scrollIntoView({ block: "start" });
  }, [focusDisplays, ready]);
  if (!screens || !summary) return <DashboardSkeleton />;
  return (
    <div className="demo-overview">
      <HostMetrics
        online={screens.filter((s) => s.deviceStatus === "online").length}
        total={screens.length}
        revenue={summary.totals.confirmedRevenueMinor}
        booked={summary.billboards.reduce((sum, b) => sum + b.slotCounts.booked + b.slotCounts.scheduled, 0)}
        completed={summary.billboards.reduce((sum, b) => sum + b.slotCounts.played, 0)}
        slotTotal={summary.billboards.reduce((sum, b) => sum + Object.values(b.slotCounts).reduce((n, count) => n + count, 0), 0)}
      />
      <div className="host-content-grid">
      <ConnectedDisplays
        autoSell={live?.autoSell}
        displays={screens.map((s) => ({
          id: s._id,
          name: s.name,
          city: s.city,
          online: s.deviceStatus === "online",
          floorMinor: s.reserveFloorMinor,
        }))}
      />
      <aside className="host-side-rail">
        <LiveSales />
        {focusScreen && <InviteRosterPanel billboardId={focusScreen._id} />}
        <LeadOutreachPanel />
        <PlaybackSummary completed={summary.billboards.reduce((sum, b) => sum + b.slotCounts.played, 0)} />
      </aside>
      </div>
      {summary.billboards.some((b) => b.openExceptions > 0) && (
        <a href="#/console?tools=1" className="demo-text-link text-danger">
          {summary.totals.openExceptions} open finance{" "}
          {summary.totals.openExceptions === 1 ? "issue needs" : "issues need"}{" "}
          your attention →
        </a>
      )}
      {summary.billboards.some((b) => b.truncated) && (
        <p className="demo-data-note">
          Some totals have reached the reporting limit. Open the operational
          tools for more detail.
        </p>
      )}
    </div>
  );
}

export function HostMetrics({ online, total, revenue, booked, completed, slotTotal }: {
  online: number; total: number; revenue: number; booked: number; completed: number; slotTotal?: number;
}) {
  const fill = slotTotal ? Math.round(booked / slotTotal * 100) : 0;
  return <section className="host-metrics" aria-label="Key statistics">
    <div className="host-metric"><div className="metric-top"><span>Displays Online</span><span className={`metric-badge ${online ? "status-online" : ""}`}><i className={`status-dot ${online ? "online" : "attention"}`} />{total ? Math.round(online / total * 100) : 0}% Active</span></div><div><strong>{online.toLocaleString()} <small>/ {total.toLocaleString()}</small></strong><p>{total - online > 0 ? <><Warning size={14} className="status-attention" />{total - online} offline</> : "All displays connected"}</p></div></div>
    <div className="host-metric"><div className="metric-top"><span>Confirmed Revenue</span></div><div><strong>{money(revenue)}</strong><p>From confirmed bookings</p></div></div>
    <div className="host-metric"><div className="metric-top"><span>Booked Slots</span>{slotTotal !== undefined && <span className="metric-rate">{fill}% booked</span>}</div><div><strong>{booked.toLocaleString()}</strong>{slotTotal !== undefined && <div className="metric-progress" role="meter" aria-label="Booked slot share" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fill}><span style={{width: `${fill}%`}} /></div>}<p>Last 24 hours + next 7 days</p></div></div>
    <div className="host-metric"><div className="metric-top"><span>Completed Slots</span></div><div><strong>{completed.toLocaleString()}</strong><p>Recorded in the reporting window</p></div></div>
  </section>;
}

export function PlaybackSummary({ completed, sample = false }: { completed: number; sample?: boolean }) {
  return <section className="playback-summary"><div><h2>Playback Records</h2><CheckCircle size={18} /></div><p>{completed.toLocaleString()} completed slots in the reporting window.</p>{sample ? <span className="sample-data-label">Illustrative data</span> : <a href="#/console?tools=1">View operational activity <ArrowRight size={16} /></a>}</section>;
}
