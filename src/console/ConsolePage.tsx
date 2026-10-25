import { useState } from "react";
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

export function ConsolePage() {
  const billboards = useQuery(api.billboards.mine, {});
  const [picked, setPicked] = useState<Id<"billboards"> | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [adding, setAdding] = useState(false);
  const billboardId = picked ?? billboards?.[0]?._id ?? null;

  if (billboards === undefined) return <PageSkeleton />;
  if (billboards.length === 0) {
    return (
      <main className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-16 md:px-6">
        <div>
          <h1 className="text-xl font-semibold">No screens yet</h1>
          <p className="mt-2 max-w-[60ch] text-muted">
            Pair your first device. Once it's online, company agents get
            offers for the spot on air automatically.
          </p>
        </div>
        <PairScreenForm />
        <CreaoRehearsalPanel />
      </main>
    );
  }

  return (
    <main className="demo-dashboard demo-container">
      <div className="demo-dashboard-heading">
        <div>
          <p className="demo-eyebrow">Your screens, at a glance.</p>
          <h1>A little space. A lot of possibility.</h1>
          <p>Your displays, what’s playing, and the numbers that matter.</p>
        </div>
        <button
          type="button"
          className="demo-button"
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
        >
          {adding ? "Close" : "+ Add a display"}
        </button>
      </div>
      {adding && (
        <div className="mb-8">
          <PairScreenForm onDone={() => setAdding(false)} />
        </div>
      )}
      <HostOverview />
      <div className="mt-10">
        <CreaoRehearsalPanel />
      </div>
      <details
        className="demo-tools"
        onToggle={(e) => setShowTools(e.currentTarget.open)}
      >
        <summary>
          Operational tools · creatives, finance exceptions, activity
        </summary>
        {showTools && (
          <div>
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
          </div>
        )}
      </details>
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
      <div className="mt-8 grid grid-cols-2 gap-6 md:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-16 animate-pulse rounded bg-panel" />
        ))}
      </div>
      <div className="mt-10 h-64 animate-pulse rounded bg-panel" />
    </main>
  );
}
