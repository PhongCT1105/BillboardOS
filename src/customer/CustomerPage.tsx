import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { CampaignsPanel } from "./CampaignsPanel";
import { WatchRulesPanel } from "./WatchRulesPanel";
import { AlertsPanel } from "./AlertsPanel";
import { AgentKeysPanel } from "./AgentKeysPanel";
import { BookingsPanel } from "./BookingsPanel";

export const CUSTOMER_TABS = [
  { key: "alerts", label: "Alerts" },
  { key: "watch", label: "Watch rules" },
  { key: "campaigns", label: "Campaigns" },
  { key: "agents", label: "Agent keys" },
  { key: "bookings", label: "Bookings & invoices" },
] as const;
export type CustomerTab = (typeof CUSTOMER_TABS)[number]["key"];

/** Customer dashboard: #/customer/<tab>. */
export function CustomerPage({ tab, companyName }: { tab: CustomerTab; companyName: string }) {
  const inbox = useQuery(api.alerts.inbox, { limit: 1 });
  return (
    <main className="mx-auto max-w-[1200px] px-4 pt-8 pb-20 md:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{companyName}</h1>
      <p className="mt-1 text-sm text-muted">Campaigns, deal alerts, your buying agents and what you've booked.</p>
      <nav aria-label="Dashboard sections" className="mt-6 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none]">
        {CUSTOMER_TABS.map((t) => (
          <a
            key={t.key}
            href={`#/customer/${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors ${
              tab === t.key ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {t.label}
            {t.key === "alerts" && inbox && inbox.unreadCount > 0 && (
              <span className="tabular rounded-full bg-accent px-1.5 py-px font-mono text-[11px] font-semibold text-accent-ink">
                {inbox.unreadCapped ? "99+" : inbox.unreadCount}
              </span>
            )}
          </a>
        ))}
      </nav>
      <div className="mt-8">
        {tab === "alerts" && <AlertsPanel />}
        {tab === "watch" && <WatchRulesPanel />}
        {tab === "campaigns" && <CampaignsPanel />}
        {tab === "agents" && <AgentKeysPanel />}
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
