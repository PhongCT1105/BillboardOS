import { useState } from "react";
import { ArrowLeft, ArrowUpRight, Megaphone } from "@phosphor-icons/react";
import { Brand, Metrics, PrimaryLink } from "./ui";
import { Displays } from "./Displays";

const displays = [
  {
    id: "cafe",
    name: "Neighborhood café",
    city: "San Francisco",
    online: true,
  },
  {
    id: "lobby",
    name: "Market Street lobby",
    city: "San Francisco",
    online: true,
  },
  { id: "studio", name: "The corner studio", city: "Oakland", online: false },
];

export function DemoPage() {
  const [tab, setTab] = useState("overview");
  return (
    <div className="demo-site">
      <header className="demo-site-header demo-container">
        <Brand />
        <nav aria-label="Demo navigation">
          <a href="#/">
            <ArrowLeft size={15} />
            Back to home
          </a>
          <PrimaryLink href="#/signin">Try with your own ad</PrimaryLink>
        </nav>
      </header>
      <main className="demo-dashboard demo-container">
        <div className="demo-sample-banner">
          <span>Interactive preview · sample data</span>
          <span>No account needed</span>
        </div>
        <div className="demo-dashboard-heading">
          <div>
            <p className="demo-eyebrow">Your brand, out there.</p>
            <h1>Good things are showing up.</h1>
            <p>Your displays, campaigns, and results. All in one place.</p>
          </div>
          <PrimaryLink href="#/signin">Create a campaign</PrimaryLink>
        </div>
        <nav className="demo-tabs" aria-label="Dashboard sections">
          {["overview", "displays", "campaigns"].map((t) => (
            <button
              type="button"
              key={t}
              className={tab === t ? "is-active" : ""}
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <div className="demo-overview">
          {tab === "overview" && (
            <Metrics
              items={[
                {
                  label: "Active campaigns",
                  value: "1",
                  detail: "Sample campaign",
                },
                {
                  label: "Confirmed bookings",
                  value: "8",
                  detail: "Across 2 sample displays",
                },
                {
                  label: "Completed bookings",
                  value: "6",
                  detail: "Illustrative playback results",
                },
                {
                  label: "Booked spend",
                  value: "$120.00",
                  detail: "Illustrative campaign spend",
                },
              ]}
            />
          )}
          {tab !== "campaigns" && <Displays displays={displays} sample />}
          {tab !== "displays" && (
            <section>
              <div className="demo-section-heading">
                <div>
                  <h2>Your campaigns</h2>
                  <p>A little local presence goes a long way.</p>
                </div>
              </div>
              <a href="#/signin" className="demo-campaign-row">
                <span className="demo-campaign-icon">
                  <Megaphone size={21} />
                </span>
                <div>
                  <strong>Cold brew. Around the corner.</strong>
                  <span>Golden Gate Coffee Co. · Sample campaign</span>
                </div>
                <span className="demo-status is-online">Active</span>
                <ArrowUpRight size={17} />
              </a>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
