import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ago, money } from "../lib/format";
import { useNow } from "../lib/hooks";
import { SEGMENTS } from "../lib/segments";
import { Card, ErrorLine, Field, Pill, inputCls, primaryBtn, secondaryBtn, useAction } from "../customer/ui";
import { RoundsPanel } from "./RoundsPanel";

type Live = FunctionReturnType<typeof api.moments.live>;
type Device = Live["devices"][number];

const MINUTE = 60_000;

/** Host presenter view: devices, the bidding round on this screen (Sell now, bids with reasons), pricing, event and top-ups. */
export function MomentPage() {
  const screens = useQuery(api.billboards.mine, {});
  const [picked, setPicked] = useState<Id<"billboards"> | null>(null);
  const billboardId = picked ?? screens?.[0]?._id ?? null;
  if (screens === undefined) {
    return (
      <main className="mx-auto max-w-[1400px] px-4 pt-8 md:px-6">
        <div className="h-96 animate-pulse rounded-lg bg-panel" />
      </main>
    );
  }
  if (!billboardId) {
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-16 md:px-6">
        <p className="text-muted">Add a screen first (Workspace).</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-[1400px] px-4 pt-6 pb-20 md:px-6">
      {screens.length > 1 && (
        <select
          aria-label="Screen"
          className="mb-4 rounded-md border border-line bg-panel px-3 py-2 text-sm text-fg"
          value={billboardId}
          onChange={(e) => setPicked(e.target.value as Id<"billboards">)}
        >
          {screens.map((s) => (
            <option key={s._id} value={s._id}>
              {s.name}, {s.city}
            </option>
          ))}
        </select>
      )}
      <MomentStage key={billboardId} billboardId={billboardId} />
    </main>
  );
}

function MomentStage({ billboardId }: { billboardId: Id<"billboards"> }) {
  const now = useNow(100);
  const atMinute = Math.floor(now / 15_000) * 15_000;
  // Keep showing the last result while the query re-subscribes with new time args (no flicker on stage).
  const live = useSticky(useQuery(api.moments.live, { billboardId, atMinute }));

  if (live === undefined) return <div className="h-96 animate-pulse rounded-lg bg-panel" />;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-medium tracking-widest text-accent uppercase">Bidding rounds</p>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{live.screen.name}</h1>
        <p className="mt-1 text-sm text-muted">
          {live.screen.locationLabel}
          {live.screen.event && ` · ${live.screen.event.name} next door`}
        </p>
      </header>

      <Devices devices={live.devices} queue={live.queue} now={now} active={billboardId} />

      <RoundsPanel billboardId={billboardId} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <PricingPanel billboardId={billboardId} />
        <EventPanel billboardId={billboardId} />
        <TopUpPanel />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- devices and queue

const MODE_LABEL: Record<Device["mode"], string> = {
  announce: "Announcing a spot",
  auction: "Live auction",
  negotiation: "Negotiating",
  settling: "Winner paying",
  playing: "Playing a paid ad",
  your_ad_here: "Waiting",
};

function Devices({ devices, queue, now, active }: { devices: Live["devices"]; queue: Live["queue"]; now: number; active: Id<"billboards"> }) {
  return (
    <section className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-3">
        <p className="text-xs tracking-widest text-muted uppercase">Devices</p>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {devices.map((d) => {
            // The query never reads the clock: a paid spot that has ended no longer counts as playing.
            const expired = d.mode === "playing" && d.spotEndAt !== null && now > d.spotEndAt;
            const mode = expired ? "your_ad_here" : d.mode;
            const busy = mode !== "your_ad_here";
            return (
              <li key={d.billboardId} className={`rounded-lg border bg-panel px-4 py-3 ${d.billboardId === active ? "border-accent/60" : "border-line"}`}>
                <div className="flex items-start justify-between gap-3">
                  <p className="truncate text-xl font-semibold">{d.name}</p>
                  <Pill tone={d.online ? "ok" : "danger"}>{d.online ? "online" : "offline"}</Pill>
                </div>
                <p className="tabular mt-2 font-mono text-4xl font-semibold">
                  {d.peopleInView === null ? "-" : d.peopleInView}
                  <span className="ml-2 font-sans text-sm font-normal text-muted">{d.peopleInView === null ? "no camera reading" : d.peopleInView === 1 ? "person in view" : "people in view"}</span>
                </p>
                <p className={`mt-1 text-sm ${busy ? "text-accent" : "text-muted"}`}>{MODE_LABEL[mode]}</p>
                <a href={`#/player/${d.billboardId}`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-accent underline-offset-4 hover:underline">
                  Open the screen
                </a>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="flex flex-col gap-3">
        <p className="text-xs tracking-widest text-muted uppercase">Auction queue</p>
        <Card className="flex-1">
          {queue.length === 0 ? (
            <p className="text-sm text-muted">No screen is waiting. One live auction runs at a time; the next screen to detect a crowd queues here.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {queue.map((q, i) => (
                <li key={q.billboardId} className="flex items-baseline justify-between gap-3">
                  <span className="text-lg">
                    <span className="tabular mr-2 font-mono text-muted">{i + 1}</span>
                    {q.name}
                  </span>
                  <span className="text-xs text-faint">waiting {ago(q.queuedAt, now)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </section>
  );
}

function PricingPanel({ billboardId }: { billboardId: Id<"billboards"> }) {
  const screens = useQuery(api.billboards.mine, {});
  const set = useMutation(api.billboards.setLivePricing);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const screen = screens?.find((s) => s._id === billboardId);
  if (!screen) return null;
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaved(false);
    const ok = await run(async () => {
      await set({ billboardId, minimumMinor: Math.round(Number(f.get("min")) * 100), cpmMinor: Math.round(Number(f.get("cpm")) * 100) });
      return true;
    });
    if (ok) setSaved(true);
  }
  return (
    <Card>
      <h2 className="font-semibold">Live pricing: {screen.name}</h2>
      <p className="mt-1 text-sm text-muted">The published minimum no spot sells under, and the starting price per 1,000 views.</p>
      <form key={`${screen.reserveFloorMinor}${screen.cpmMinor}`} className="mt-4 grid grid-cols-2 gap-4" onSubmit={onSubmit}>
        <Field label="Minimum price ($)" hint={`Up to ${money(screen.baseRateMinor)}`}>
          <input name="min" defaultValue={(screen.reserveFloorMinor / 100).toFixed(2)} inputMode="decimal" className={`${inputCls} font-mono`} />
        </Field>
        <Field label="Starting CPM ($ per 1,000 views)">
          <input name="cpm" defaultValue={((screen.cpmMinor ?? 500) / 100).toFixed(2)} inputMode="decimal" className={`${inputCls} font-mono`} />
        </Field>
        <div className="col-span-2 flex items-center gap-3">
          <button type="submit" disabled={busy} className={primaryBtn}>
            Save pricing
          </button>
          {saved && <span className="text-sm text-emerald-300">Saved</span>}
        </div>
        <div className="col-span-2">
          <ErrorLine error={error} />
        </div>
      </form>
    </Card>
  );
}

function EventPanel({ billboardId }: { billboardId: Id<"billboards"> }) {
  const create = useMutation(api.events.create);
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const name = String(f.get("name") ?? "").trim();
    const minutes = Number(f.get("minutes"));
    const segment = String(f.get("segment") ?? "");
    setDone(null);
    if (!name) return;
    const startsAt = Date.now();
    const ok = await run(async () => {
      await create({ billboardId, name, startsAt, endsAt: startsAt + minutes * MINUTE, ...(segment ? { audienceTags: { [segment]: 1 } } : {}) });
      return true;
    });
    if (ok) {
      form.reset();
      setDone(name);
    }
  }
  return (
    <Card>
      <h2 className="font-semibold">Add event</h2>
      <p className="mt-1 text-sm text-muted">An event happening now next to the screen. The pricing agent counts it when it prices the spot.</p>
      <form className="mt-4 grid grid-cols-2 gap-4" onSubmit={onSubmit}>
        <Field label="Event name" className="col-span-2">
          <input name="name" required maxLength={80} className={inputCls} placeholder="Startup demo day" />
        </Field>
        <Field label="Runs for (minutes)">
          <input name="minutes" type="number" min={5} max={720} defaultValue={60} className={`${inputCls} font-mono`} />
        </Field>
        <Field label="Crowd">
          <select name="segment" className={inputCls} defaultValue="">
            <option value="">Same as the screen</option>
            {SEGMENTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="col-span-2 flex items-center gap-3">
          <button type="submit" disabled={busy} className={primaryBtn}>
            Add event
          </button>
          {done && <span className="text-sm text-emerald-300">Added {done}</span>}
        </div>
        <div className="col-span-2">
          <ErrorLine error={error} />
        </div>
      </form>
    </Card>
  );
}

function TopUpPanel() {
  const companies = useQuery(api.companyAgents.hostList, {});
  const topUp = useMutation(api.companyAgents.hostTopUp);
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  return (
    <Card>
      <h2 className="font-semibold">Top up a company</h2>
      <p className="mt-1 text-sm text-muted">Send $2.00 test USDC from the operator wallet to a company agent's wallet so it can pay (the faucet covers it if the operator wallet is short). Five top-ups a day per company, shared with the company's own faucet top-ups.</p>
      {companies === undefined ? null : companies.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No company has set up an agent yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {companies.map((c) => (
            <li key={c.advertiserId} className="flex items-center justify-between gap-3 border-t border-line pt-3 first:border-t-0 first:pt-0">
              <div className="min-w-0">
                <p className="truncate font-medium">{c.company}</p>
                <p className="tabular font-mono text-sm text-muted">{c.balanceMinor === null ? "no wallet yet" : `${money(c.balanceMinor)} USDC`}</p>
              </div>
              <button
                type="button"
                disabled={busy}
                className={secondaryBtn}
                onClick={async () => {
                  setDone(null);
                  const ok = await run(async () => {
                    await topUp({ advertiserId: c.advertiserId });
                    return true;
                  });
                  if (ok) setDone(c.company);
                }}
              >
                Top up
              </button>
            </li>
          ))}
        </ul>
      )}
      {done && <p className="mt-3 text-sm text-emerald-300">Top-up requested for {done}. The balance updates when it lands.</p>}
      <ErrorLine error={error} />
    </Card>
  );
}

/** The latest defined value of a query result. */
function useSticky<T>(value: T | undefined): T | undefined {
  const last = useRef<T | undefined>(value);
  if (value !== undefined) last.current = value;
  return value ?? last.current;
}
