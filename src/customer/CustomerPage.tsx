import { CampaignsPanel } from "./CampaignsPanel";
import { AgentKeysPanel } from "./AgentKeysPanel";
import { BookingsPanel } from "./BookingsPanel";
import { AgentSetupPanel } from "./AgentSetupPanel";
import { CustomerOverview } from "../demo/CustomerOverview";
import { DisplayBrowser } from "../demo/Displays";
import { PrimaryLink } from "../demo/ui";

export const CUSTOMER_TABS = [
  { key: "overview", label: "Overview" },
  { key: "displays", label: "Displays" },
  { key: "campaigns", label: "Campaigns" },
  { key: "agent", label: "Campaign setup" },
  { key: "agents", label: "Agent keys" },
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
  return (
    <main className="demo-dashboard demo-container">
      <div className="demo-dashboard-heading">
        <div>
          <h1 title={companyName}>Dashboard</h1>
        </div>
        <PrimaryLink href="#/customer/agent">Create campaign</PrimaryLink>
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
        {tab === "campaigns" && <CampaignsPanel />}
        {tab === "agents" && <AgentKeysPanel />}
        {tab === "bookings" && <BookingsPanel />}
      </div>
    </main>
  );
}
