import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useNow } from "../lib/hooks";
import { KpiStrip } from "./KpiStrip";
import { SlotBoard } from "./SlotBoard";
import { ExceptionList } from "./ExceptionList";
import { CreativeQueue } from "./CreativeQueue";
import { ActivityFeed } from "./ActivityFeed";
import { AddScreenForm } from "../auth/Onboarding";
import { LiveAuctions } from "../auctions/LiveAuctions";
import { NegotiationTimeline } from "../a2a/NegotiationTimeline";
import { AutopilotPanel } from "../autopilot/AutopilotPanel";

const QUARTER_HOUR = 15 * 60 * 1000;

export function ConsolePage() {
  const billboards = useQuery(api.billboards.mine, {});
  const [picked, setPicked] = useState<Id<"billboards"> | null>(null);
  const billboardId = picked ?? billboards?.[0]?._id ?? null;

  if (billboards === undefined) return <PageSkeleton />;
  if (billboards.length === 0) {
    return (
      <main className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-16 md:px-6">
        <div>
          <h1 className="text-xl font-semibold">No screens yet</h1>
          <p className="mt-2 max-w-[60ch] text-muted">Add your first screen; 12 hours of 15-minute slots go on sale right away.</p>
        </div>
        <AddScreenForm />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[1400px] px-4 pb-16 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4 pt-8 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Operator console</h1>
          <p className="mt-1 text-sm text-muted">Your seller agent sells the next 12 hours; the live auction sells the current spot. Watch them work.</p>
        </div>
        {billboards.length > 1 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Billboard</span>
            <select
              className="rounded-md border border-line bg-panel px-3 py-2 text-fg"
              value={billboardId ?? ""}
              onChange={(e) => setPicked(e.target.value as Id<"billboards">)}
            >
              {billboards.map((b) => (
                <option key={b._id} value={b._id}>
                  {b.name}, {b.city}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="mb-10">
        <AutopilotPanel />
      </div>
      {billboardId && <ConsoleBody billboardId={billboardId} />}
    </main>
  );
}

function ConsoleBody({ billboardId }: { billboardId: Id<"billboards"> }) {
  const now = useNow(5_000);
  const minute = Math.floor(now / 60_000) * 60_000;
  // Two hours of history, the current slot and the next 12 hours.
  const from = Math.floor(minute / QUARTER_HOUR) * QUARTER_HOUR - 8 * QUARTER_HOUR;
  const to = from + 14 * 60 * 60 * 1000;

  const summary = useQuery(api.dashboard.summary, {});
  const outlook = useQuery(api.autopilot.outlook, { billboardId, from, to, atMinute: minute });
  const audience = useQuery(api.audience.recentForBillboard, { billboardId });
  const exceptions = useQuery(api.finance.openExceptions, {});
  const pending = useQuery(api.creatives.pendingReview, {});
  const activity = useQuery(api.audit.recent, {});
  const negotiations = useQuery(api.negotiations.forWorkspace, {});
  const dataSales = useQuery(api.a2a.dataSalesForWorkspace, {});

  const row = summary?.billboards.find((b) => b.billboardId === billboardId);

  return (
    <div className="flex flex-col gap-10">
      <KpiStrip summary={row} audience={audience} />
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-10">
          <LiveAuctions billboardId={billboardId} />
          <SlotBoard outlook={outlook} now={now} />
          <ExceptionList exceptions={exceptions} />
          <CreativeQueue pending={pending} />
          <section aria-labelledby="negotiations-heading" className="flex flex-col gap-4">
            <div>
              <h2 id="negotiations-heading" className="text-lg font-semibold">
                Seller agent
              </h2>
              <p className="mt-1 text-sm text-muted">Buyer agents negotiating with your seller agent, and data they bought, paid over x402.</p>
            </div>
            <NegotiationTimeline
              items={negotiations}
              sales={dataSales?.recent}
              perspective="host"
              empty="No agent conversations yet. Buyer agents find your seller agent at /a2a/hosts/<workspace>/agent.json on the x402 server."
            />
          </section>
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
