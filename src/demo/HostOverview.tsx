import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { money } from "../lib/format";
import { Displays } from "./Displays";
import { DashboardSkeleton, Metrics } from "./ui";

export function HostOverview() {
  const screens = useQuery(api.billboards.mine, {});
  const summary = useQuery(api.dashboard.summary, {});
  if (!screens || !summary) return <DashboardSkeleton />;
  return (
    <div className="demo-overview">
      <Metrics
        items={[
          {
            label: "Displays online",
            value: `${screens.filter((s) => s.deviceStatus === "online").length} / ${screens.length}`,
            detail: "Across your workspace",
          },
          {
            label: "Confirmed revenue",
            value: money(summary.totals.confirmedRevenueMinor),
            detail: "From confirmed bookings",
          },
          {
            label: "Booked ad slots",
            value: String(
              summary.billboards.reduce(
                (sum, b) => sum + b.slotCounts.booked + b.slotCounts.scheduled,
                0,
              ),
            ),
            detail: "Previous 24 hours + next 7 days",
          },
          {
            label: "Completed ad slots",
            value: String(
              summary.billboards.reduce(
                (sum, b) => sum + b.slotCounts.played,
                0,
              ),
            ),
            detail: "Within the reporting window",
          },
        ]}
      />
      <Displays
        displays={screens.map((s) => ({
          id: s._id,
          name: s.name,
          city: s.city,
          online: s.deviceStatus === "online",
        }))}
        host
      />
      {summary.billboards.some((b) => b.openExceptions > 0) && (
        <a href="#/finance" className="demo-text-link text-danger">
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
