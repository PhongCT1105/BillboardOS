import { useQuery } from "convex/react";
import { ArrowUpRight, Megaphone, Plus } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { money, words } from "../lib/format";
import { DisplayBrowser } from "./Displays";
import { DashboardSkeleton, Metrics } from "./ui";
import { AdAudience } from "../audience/AdAudience";

export function CustomerOverview() {
  const campaigns = useQuery(api.campaigns.list, {});
  const bookings = useQuery(api.customerPortal.bookings, {});
  if (!campaigns || !bookings) return <DashboardSkeleton />;
  const confirmed = bookings.filter((b) => b.status !== "failed");
  return (
    <div className="demo-overview">
      <Metrics
        compact
        items={[
          {
            label: "Active campaigns",
            value: String(
              campaigns.filter((c) => c.status === "active").length,
            ),
            detail: "Ready to reach your audience",
          },
          {
            label: "Confirmed bookings",
            value: String(confirmed.length),
            detail: "Across your recent bookings",
          },
          {
            label: "Completed bookings",
            value: String(bookings.filter((b) => b.status === "played").length),
            detail: "With confirmed playback",
          },
          {
            label: "Booked spend",
            value: money(confirmed.reduce((sum, b) => sum + b.amountMinor, 0)),
            detail: "Total of recent confirmed bookings",
          },
        ]}
      />
      <AdAudience />
      <DisplayBrowser />
      <section aria-labelledby="campaigns-heading">
        <div className="demo-section-heading">
          <div>
            <h2 id="campaigns-heading">Campaigns</h2>
          </div>
          <a href="#/customer/campaigns" className="demo-text-link">
            Manage campaigns <ArrowUpRight size={16} />
          </a>
        </div>
        {campaigns.length ? (
          <div className="demo-campaign-list">
            {campaigns.slice(0, 4).map((c) => (
              <a
                key={c._id}
                href={`#/book?campaign=${c._id}`}
                className="demo-campaign-row"
              >
                <span className="demo-campaign-icon">
                  <Megaphone size={20} />
                </span>
                <div>
                  <strong>{c.brief}</strong>
                  <span>
                    {c.targetCity ?? "Any city"} · {money(c.budgetMinor)} budget
                  </span>
                </div>
                <span
                  className={`demo-status ${c.status === "active" ? "is-online" : ""}`}
                >
                  {words(c.status)}
                </span>
                <ArrowUpRight size={17} />
              </a>
            ))}
          </div>
        ) : (
          <div className="demo-empty">
            <Megaphone size={28} />
            <h3>No campaigns yet</h3>
            <a
              href="#/customer/campaigns"
              className="demo-button demo-button-small"
            >
              <Plus size={16} />
              Create a campaign
            </a>
          </div>
        )}
      </section>
      <p className="demo-data-note">
        Figures reflect the recent bookings available to your account.
      </p>
    </div>
  );
}
