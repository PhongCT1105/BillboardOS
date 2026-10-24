import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ago, money, timeOfDay } from "../lib/format";
import { useNow } from "../lib/hooks";
import { SEGMENTS } from "../lib/segments";
import { txUrl } from "../a2a/NegotiationTimeline";
import { Card, ErrorLine, Field, Pill, inputCls, primaryBtn, secondaryBtn, useAction } from "../customer/ui";

type Live = FunctionReturnType<typeof api.moments.live>;
type Moment = NonNullable<Live["latest"]>;
type Device = Live["devices"][number];

const MINUTE = 60_000;

/** Host "Live moment" view (ADR 0006): stage-friendly, everything on one screen. */
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
  const m = live.latest;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-xs font-medium tracking-widest text-accent uppercase">Live moment</p>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{live.screen.name}</h1>
        <p className="mt-1 text-sm text-muted">
          {live.screen.locationLabel}
          {live.screen.event && ` · ${live.screen.event.name} next door`}
        </p>
      </header>

      <Devices devices={live.devices} queue={live.queue} now={now} active={billboardId} />

      {m ? <MomentDetail m={m} now={now} /> : <Waiting />}

      <History rows={live.history} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsPanel />
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

function Waiting() {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-16 text-center">
      <p className="text-lg">Waiting for a crowd.</p>
      <p className="mt-1 text-sm text-muted">The pricing agent announces a spot when the camera sees enough people in view.</p>
    </div>
  );
}

// ---------------------------------------------------------------- the moment

const STATUS_LABEL: Record<string, string> = {
  offering: "Joining open",
  bidding: "Live auction",
  negotiating: "Negotiating",
  awarded: "Waiting for payment",
  paid: "Paid, scheduled",
  playing: "On screen",
  no_takers: "No takers",
  failed: "Failed",
};

function Stopwatch({ m, now }: { m: Moment; now: number }) {
  const ended = m.status === "failed" || m.status === "no_takers";
  const end = m.firstFrameAt ?? (ended ? (m.steps.at(-1)?.at ?? now) : now);
  const ms = Math.max(0, end - m.startedAt);
  const stopped = m.firstFrameAt !== null || ended;
  const under = m.firstFrameAt !== null && ms < 30_000;
  return (
    <div className="flex flex-col items-start">
      <p className="text-sm tracking-widest text-muted uppercase">{m.firstFrameAt ? "Crowd detected to first frame" : stopped ? "Stopped" : "Crowd detected, running"}</p>
      <p className={`tabular font-mono text-7xl font-semibold md:text-8xl ${under ? "text-emerald-300" : stopped ? "text-muted" : "text-fg"}`}>
        {(ms / 1000).toFixed(1)}
        <span className="text-4xl">s</span>
      </p>
      {under && <p className="text-lg text-emerald-300">Under 30 seconds</p>}
    </div>
  );
}

/** Shown only once a moment is past its bound (its close never ran): end it so the host's queue moves. */
function EndStuck({ momentId }: { momentId: Id<"moments"> }) {
  const endStuck = useMutation(api.moments.endStuck);
  const end = useAction();
  return (
    <div className="mt-2 flex flex-col items-end gap-1">
      <button type="button" className={secondaryBtn} disabled={end.busy} onClick={() => void end.run(() => endStuck({ momentId }))}>
        {end.busy ? "Ending…" : "End stuck moment"}
      </button>
      <ErrorLine error={end.error} />
    </div>
  );
}

function MomentDetail({ m, now }: { m: Moment; now: number }) {
  const closesLeft = m.status === "bidding" && m.biddingClosesAt !== null ? Math.max(0, m.biddingClosesAt - now) : m.status === "offering" ? Math.max(0, m.offerClosesAt - now) : null;
  const price = m.winner ? money(m.winner.amountMinor) : money(m.priceMinor);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex flex-col gap-6">
        <section className="flex flex-wrap items-end justify-between gap-6 rounded-xl border border-line bg-panel p-6">
          <Stopwatch m={m} now={now} />
          <div className="text-right">
            <p className="text-sm text-muted">{STATUS_LABEL[m.status] ?? m.status}</p>
            <p className="tabular font-mono text-4xl">{price}</p>
            <p className="text-sm text-faint">
              {Math.round((m.spotEndAt - m.spotStartAt) / MINUTE)} min, {timeOfDay(m.spotStartAt)} to {timeOfDay(m.spotEndAt)} · opened at {money(m.priceMinor)}, minimum {money(m.floorMinor)}
            </p>
            {closesLeft !== null && (
              <p className="tabular mt-1 font-mono text-xl text-accent">
                {m.status === "bidding" ? "Bidding closes" : "Joining closes"} in {(closesLeft / 1000).toFixed(1)} s
                {m.extensions > 0 && <span className="ml-2 text-sm text-faint">extended {m.extensions}x</span>}
              </p>
            )}
            {m.stuckAfter !== null && now > m.stuckAfter && <EndStuck momentId={m.momentId} />}
          </div>
        </section>

        <section className="rounded-xl border border-line bg-panel p-5">
          <p className="text-xs tracking-widest text-muted uppercase">Pricing agent reasoning</p>
          {m.valueMinor !== null && (
            <p className="mt-2 text-sm text-muted">
              Worth about <span className="tabular font-mono text-fg">{money(m.valueMinor)}</span> to the audience in view
            </p>
          )}
          <p className="mt-2 text-xl leading-snug">{m.priceWhy ?? m.reasoning}</p>
        </section>

        <Timeline m={m} />
      </div>

      <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
        <Payment m={m} />
        <Ladder m={m} />
      </aside>
    </div>
  );
}

function Timeline({ m }: { m: Moment }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <p className="text-xs tracking-widest text-muted uppercase">Timeline: joins, bids, counters, award, payment</p>
      <ol className="mt-3 flex flex-col gap-2.5">
        {m.steps.map((s, i) => (
          <li key={i} className="grid grid-cols-[76px_minmax(0,1fr)] gap-3">
            <span className="tabular text-right font-mono text-base text-muted">+{((s.at - m.startedAt) / 1000).toFixed(1)}s</span>
            <span>
              <span className="text-lg text-fg">{s.label}</span>
              {s.detail && <span className="block text-sm text-faint">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Ladder({ m }: { m: Moment }) {
  if (m.bids.length === 0) return null;
  const kind = { bid: "bid", buyer_offer: "buyer offer", seller_counter: "host counter" } as const;
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <p className="text-xs tracking-widest text-muted uppercase">Bids</p>
      <ul className="mt-3 flex flex-col gap-2">
        {m.bids.map((b, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">
              <span className="text-base">{b.company}</span>
              <span className="ml-2 text-xs text-faint">{kind[b.kind]} · +{((b.at - m.startedAt) / 1000).toFixed(1)}s</span>
            </span>
            <span className="tabular font-mono text-lg">{money(b.amountMinor)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Payment({ m }: { m: Moment }) {
  const url = m.paymentTx && m.paymentNetwork ? txUrl(m.paymentNetwork, m.paymentTx) : null;
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <p className="text-xs tracking-widest text-muted uppercase">Payment</p>
      {m.paymentTx ? (
        <>
          <p className="mt-2 text-2xl font-semibold text-emerald-300">Paid {m.paidMinor !== null ? money(m.paidMinor) : ""} USDC</p>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="mt-1 block truncate font-mono text-sm text-accent underline-offset-4 hover:underline">
              View on Basescan: {m.paymentTx}
            </a>
          ) : (
            <p className="mt-1 truncate font-mono text-sm text-muted">{m.paymentTx}</p>
          )}
        </>
      ) : m.paymentBlocked ? (
        <p className="mt-2 text-xl font-semibold text-danger">Payment blocked: {m.paymentBlocked}</p>
      ) : (
        <p className="mt-2 text-sm text-muted">{m.status === "awarded" && m.winner ? `Waiting for ${m.winner.company} to pay over x402` : "No payment yet"}</p>
      )}
    </section>
  );
}

function History({ rows }: { rows: Live["history"] }) {
  const now = useNow(30_000);
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="text-lg font-semibold">Recent moments</h2>
      <div className="mt-3 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-panel text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Relevant viewers</th>
              <th className="px-4 py-2 font-medium">Winner</th>
              <th className="px-4 py-2 text-right font-medium">Price</th>
              <th className="px-4 py-2 font-medium">Payment</th>
              <th className="px-4 py-2 text-right font-medium">Crowd to screen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.momentId} className="border-t border-line">
                <td className="px-4 py-2 text-muted">{ago(r.startedAt, now)}</td>
                <td className="px-4 py-2">{r.relevantViewers}</td>
                <td className="px-4 py-2">{r.winner ?? <span className="text-faint">{STATUS_LABEL[r.status] ?? r.status}</span>}</td>
                <td className="tabular px-4 py-2 text-right font-mono">{r.paidMinor !== null ? money(r.paidMinor) : "-"}</td>
                <td className="px-4 py-2">{r.paymentMode === "x402" ? "x402" : "-"}</td>
                <td className="tabular px-4 py-2 text-right font-mono">{r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)} s` : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- host controls

function SettingsPanel() {
  const me = useQuery(api.workspaces.get, {});
  const settings = useQuery(api.moments.settings, {});
  const save = useMutation(api.moments.updateSettings);
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  if (!me || !settings) return null;
  const owner = me.myRole === "owner";
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaved(false);
    const ok = await run(async () => {
      await save({
        workspaceId: me!.workspaceId,
        enabled: f.get("enabled") === "on",
        minPeopleInView: Number(f.get("min")),
        joinWindowSeconds: Number(f.get("window")),
        minMatch: Number(f.get("match")) / 100,
      });
      return true;
    });
    if (ok) setSaved(true);
  }
  return (
    <Card>
      <h2 className="font-semibold">Moment settings</h2>
      <p className="mt-1 text-sm text-muted">When the pricing agent announces a spot and how long companies have to join.{!owner && " Only the owner can change these."}</p>
      <form key={`${settings.enabled}${settings.minPeopleInView}${settings.joinWindowSeconds}${settings.minMatch}`} className="mt-4 grid grid-cols-2 gap-4" onSubmit={onSubmit}>
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={settings.enabled} disabled={!owner} /> Detector on
        </label>
        <Num name="min" label="Min people in view" value={settings.minPeopleInView} disabled={!owner} />
        <Num name="window" label="Join window (s)" value={settings.joinWindowSeconds} disabled={!owner} />
        <Num name="match" label="Min audience match (%)" value={Math.round(settings.minMatch * 100)} disabled={!owner} />
        {owner && (
          <div className="col-span-2 flex items-center gap-3">
            <button type="submit" disabled={busy} className={primaryBtn}>
              Save settings
            </button>
            {saved && <span className="text-sm text-emerald-300">Saved</span>}
          </div>
        )}
        <div className="col-span-2">
          <ErrorLine error={error} />
        </div>
      </form>
    </Card>
  );
}

function Num(props: { name: string; label: string; value: number; disabled: boolean }) {
  return (
    <Field label={props.label}>
      <input name={props.name} defaultValue={props.value} disabled={props.disabled} inputMode="numeric" className={`${inputCls} font-mono`} />
    </Field>
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
