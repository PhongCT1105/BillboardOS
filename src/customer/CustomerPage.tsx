import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { CampaignsPanel } from "./CampaignsPanel";
import { WatchRulesPanel } from "./WatchRulesPanel";
import { AlertsPanel } from "./AlertsPanel";
import { AgentKeysPanel } from "./AgentKeysPanel";
import { BookingsPanel } from "./BookingsPanel";
import { NegotiationsPanel } from "./NegotiationsPanel";
import { AgentSetupPanel } from "./AgentSetupPanel";
import { CustomerOverview } from "../demo/CustomerOverview";
import { DisplayBrowser } from "../demo/Displays";
import { PrimaryLink } from "../demo/ui";

export const CUSTOMER_TABS = [
  { key: "overview", label: "Overview" },
  { key: "displays", label: "Displays" },
  { key: "campaigns", label: "Campaigns" },
  { key: "agent", label: "Campaign setup" },
  { key: "alerts", label: "Alerts" },
  { key: "watch", label: "Watch rules" },
  { key: "agents", label: "Agent keys" },
  { key: "negotiations", label: "Negotiations" },
  { key: "bookings", label: "Bookings & invoices" },
] as const;
export type CustomerTab = (typeof CUSTOMER_TABS)[number]["key"];

/** Customer dashboard: #/customer/<tab>. */
export function CustomerPage({
  tab,
  companyName,
}: {
  tab: CustomerTab;
  companyName: string;
}) {
  const inbox = useQuery(api.alerts.inbox, { limit: 1 });
  return (
    <main className="demo-dashboard demo-container">
      <div className="demo-dashboard-heading">
        <div>
          <p className="demo-eyebrow">{companyName}</p>
          <h1>Your brand, out in the world.</h1>
          <p>Your displays, campaigns, and results. All in one place.</p>
        </div>
        <PrimaryLink href="#/customer/agent">Set up your campaign</PrimaryLink>
      </div>
      <nav aria-label="Dashboard sections" className="demo-tabs">
        {CUSTOMER_TABS.filter((t) =>
          ["overview", "displays", "campaigns"].includes(t.key),
        ).map((t) => (
          <a
            key={t.key}
            href={`#/customer/${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={tab === t.key ? "is-active" : ""}
          >
            {t.label}
          </a>
        ))}
        <details key={tab}>
          <summary>
            {["overview", "displays", "campaigns"].includes(tab)
              ? "More"
              : CUSTOMER_TABS.find((t) => t.key === tab)?.label}
            {!!inbox?.unreadCount && (
              <span className="ml-1 text-accent">
                {inbox.unreadCapped ? "99+" : inbox.unreadCount}
              </span>
            )}
          </summary>
          <div className="demo-advanced-menu">
            {CUSTOMER_TABS.filter(
              (t) => !["overview", "displays", "campaigns"].includes(t.key),
            ).map((t) => (
              <a
                key={t.key}
                href={`#/customer/${t.key}`}
                aria-current={tab === t.key ? "page" : undefined}
              >
                {t.label}
              </a>
            ))}
          </div>
        </details>
      </nav>
      <div className="mt-8">
        {tab === "overview" && <CustomerOverview />}
        {tab === "displays" && <DisplayBrowser />}
        {tab === "agent" && <AgentSetupPanel />}
        {tab === "alerts" && <AlertsPanel />}
        {tab === "watch" && <WatchRulesPanel />}
        {tab === "campaigns" && <CampaignsPanel />}
        {tab === "agents" && <AgentKeysPanel />}
        {tab === "negotiations" && <NegotiationsPanel />}
        {tab === "bookings" && <BookingsPanel />}
      </div>
    </main>
  );
}

/** Header badge for customers: unread alerts, linking to the inbox. */
export function AlertsBadgeLink({ active }: { active: boolean }) {
  const inbox = useQuery(api.alerts.inbox, { limit: 1 });
  const unread = inbox?.unreadCount ?? 0;
  return (
    <a
      href="#/customer/alerts"
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors ${active ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
    >
      Alerts
      {unread > 0 && (
        <span
          aria-label={`${unread} unread`}
          className="tabular rounded-full bg-accent px-1.5 py-px font-mono text-[11px] font-semibold text-accent-ink"
        >
          {inbox?.unreadCapped ? "99+" : unread}
        </span>
      )}
    </a>
  );
}
