import { useEffect, useState, type ReactNode } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { KpiStrip } from "./KpiStrip";
import { ExceptionList } from "./ExceptionList";
import { CreativeQueue } from "./CreativeQueue";
import { ActivityFeed } from "./ActivityFeed";
import { PairScreenForm } from "../screens/PairScreenForm";
import { HostOverview } from "../demo/HostOverview";
import { CreaoRehearsalPanel } from "./CreaoRehearsalPanel";
import { useHashParams, useHashRoute } from "../lib/hooks";

export function ConsolePage() {
  const billboards = useQuery(api.billboards.mine, {});
  const [picked, setPicked] = useState<Id<"billboards"> | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [adding, setAdding] = useState(false);
  const billboardId = picked ?? billboards?.[0]?._id ?? null;
  const params = useHashParams();
  const route = useHashRoute();
  const addRequested = params.get("add") === "1";
  const toolsRequested = params.get("tools") === "1";
  useEffect(() => {
    if (addRequested) setAdding(true);
    if (toolsRequested) setShowTools(true);
  }, [addRequested, toolsRequested]);
  function setAddPanel(open: boolean) {
    setAdding(open);
    if (!open && addRequested) {
      params.delete("add");
      window.location.hash = `${route}${params.size ? `?${params.toString()}` : ""}`;
    }
  }

  if (billboards === undefined) return <PageSkeleton />;
  if (billboards.length === 0) {
    return (
      <main className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-16 md:px-6">
        <div>
          <h1 className="text-xl font-semibold">No screens yet</h1>
          <p className="mt-2 max-w-[60ch] text-muted">
            Pair a device to add your first display.
          </p>
        </div>
        <PairScreenForm />
        <details className="demo-tools">
          <summary>Operational tools</summary>
          <div><CreaoRehearsalPanel /></div>
        </details>
      </main>
    );
  }

  return (
    <DashboardLayout adding={adding} onToggleAdd={() => setAddPanel(!adding)}>
      {adding && (
        <div className="mb-8">
          <PairScreenForm onDone={() => setAddPanel(false)} />
        </div>
      )}
      <HostOverview focusDisplays={route === "/displays"} />
      <details
        className="demo-tools"
        open={showTools}
        onToggle={(e) => setShowTools(e.currentTarget.open)}
      >
        <summary>
          Operational tools
        </summary>
        <div>
          <CreaoRehearsalPanel />
          {showTools && (
            <>
            {billboards.length > 1 && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Billboard</span>
                <select
                  className="rounded-md border border-line bg-panel px-3 py-2 text-fg"
                  value={billboardId ?? ""}
                  onChange={(e) =>
                    setPicked(e.target.value as Id<"billboards">)
                  }
                >
                  {billboards.map((b) => (
                    <option key={b._id} value={b._id}>
                      {b.name}, {b.city}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {billboardId && <ConsoleBody billboardId={billboardId} />}
            {billboardId && <a className="demo-text-link" href={`#/sensor/${billboardId}`}>Audience sensor</a>}
            </>
          )}
        </div>
      </details>
    </DashboardLayout>
  );
}

export function DashboardLayout({ adding, onToggleAdd, children }: {
  adding: boolean;
  onToggleAdd: () => void;
  children: ReactNode;
}) {
  return (
    <main className="demo-dashboard demo-container host-dashboard">
      <div className="demo-dashboard-heading">
        <div><h1>Overview</h1><p>Network status &amp; sales</p></div>
        <div className="overview-actions">
        <details className="reporting-period"><summary>Reporting window</summary><p>Ad slots: previous 24 hours and next 7 days. Revenue: confirmed bookings.</p></details>
        <button type="button" className="demo-button demo-button-primary" aria-expanded={adding} onClick={onToggleAdd}>
          {adding ? <X size={18} /> : <Plus size={18} />}
          {adding ? "Close" : "Add Display"}
        </button>
        </div>
      </div>
      {children}
    </main>
  );
}

function ConsoleBody({ billboardId }: { billboardId: Id<"billboards"> }) {
  const summary = useQuery(api.dashboard.summary, {});
  const audience = useQuery(api.audience.recentForBillboard, { billboardId });
  const exceptions = useQuery(api.finance.openExceptions, {});
  const pending = useQuery(api.creatives.pendingReview, {});
  const activity = useQuery(api.audit.recent, {});
  const row = summary?.billboards.find((b) => b.billboardId === billboardId);

  return (
    <div className="flex flex-col gap-10">
      <KpiStrip summary={row} audience={audience} />
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-10">
          <ExceptionList exceptions={exceptions} />
          <CreativeQueue pending={pending} />
        </div>
        <ActivityFeed events={activity} />
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <main className="mx-auto max-w-[1400px] px-4 pt-8 md:px-6">
      <div className="h-7 w-56 animate-pulse rounded bg-panel" />
      <div className="mt-8 grid grid-cols-2 gap-6 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-16 animate-pulse rounded bg-panel" />
        ))}
      </div>
      <div className="mt-10 h-64 animate-pulse rounded bg-panel" />
    </main>
  );
}
