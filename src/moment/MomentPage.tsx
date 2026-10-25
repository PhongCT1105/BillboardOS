import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { money } from "../lib/format";
import { SEGMENTS } from "../lib/segments";
import { ErrorLine, Field, useAction } from "../customer/ui";
import { RoundsPanel } from "./RoundsPanel";

type Screen = FunctionReturnType<typeof api.billboards.mine>[number];

const MINUTE = 60_000;

const fieldCls =
  "h-11 w-full rounded-[11px] border border-line bg-panel px-3.5 text-[17px] text-fg outline-none focus:border-accent";
const pillPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-[22px] text-[17px] font-normal text-accent-ink transition-transform active:scale-95 disabled:opacity-50";
const pillSecondary =
  "inline-flex min-h-9 items-center justify-center rounded-full border border-line bg-panel px-4 text-sm text-fg transition-transform active:scale-95 disabled:opacity-50";

/** Host Live Sales: status, bids, and quiet tools — Apple store utility density. */
export function MomentPage() {
  const screens = useQuery(api.billboards.mine, {});
  const [picked, setPicked] = useState<Id<"billboards"> | null>(null);
  const screen = screens?.find((s) => s._id === picked) ?? screens?.[0] ?? null;

  if (screens === undefined) {
    return (
      <main className="live-sales mx-auto max-w-[1120px] px-4 pt-8 md:px-8">
        <div className="h-80 animate-pulse rounded-[18px] bg-panel" />
      </main>
    );
  }
  if (!screen) {
    return (
      <main className="live-sales mx-auto max-w-[1120px] px-4 py-16 md:px-8">
        <p className="text-[17px] text-muted">Pair a screen first from Overview.</p>
      </main>
    );
  }

  return (
    <main className="live-sales mx-auto max-w-[1120px] px-4 pt-6 pb-24 md:px-8">
      {screens.length > 1 && (
        <select
          aria-label="Screen"
          className="mb-5 h-11 rounded-full border border-line bg-panel px-4 text-sm text-fg"
          value={screen._id}
          onChange={(e) => setPicked(e.target.value as Id<"billboards">)}
        >
          {screens.map((s) => (
            <option key={s._id} value={s._id}>
              {s.name}, {s.city}
            </option>
          ))}
        </select>
      )}
      <div key={screen._id} className="flex flex-col gap-6">
        <ScreenHeader screen={screen} />
        <RoundsPanel billboardId={screen._id} />
        <div className="live-tools grid grid-cols-1 gap-4 lg:grid-cols-3">
          <FloorPanel screen={screen} />
          <EventPanel billboardId={screen._id} />
          <TopUpPanel />
        </div>
      </div>
    </main>
  );
}

function ScreenHeader({ screen }: { screen: Screen }) {
  const tags = Object.entries(screen.audienceTags ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const label = (key: string) => SEGMENTS.find((s) => s.key === key)?.label ?? key;
  const online = screen.deviceStatus === "online";

  return (
    <header className="live-header">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h1 className="text-[34px] font-semibold leading-[1.1] tracking-[-0.37px] text-fg md:text-[40px]">
          {screen.name}
        </h1>
        <span className={`live-status ${online ? "is-online" : "is-offline"}`}>
          <i className={`status-dot ${online ? "online" : "attention"}`} />
          {online ? "Online" : "Offline"}
        </span>
      </div>
      <p className="mt-1 text-sm text-faint">
        {screen.locationLabel}, {screen.city}
      </p>
      {tags.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Audience">
          {tags.map(([k, w]) => (
            <li key={k} className="live-chip">
              {label(k)}
              <span className="tabular text-faint">{Math.round(w * 100)}%</span>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

function FloorPanel({ screen }: { screen: Screen }) {
  const setFloor = useMutation(api.billboards.setFloor);
  const setWeights = useMutation(api.pricing.setWeights);
  const trainNow = useMutation(api.pricing.trainNow);
  const model = useQuery(api.pricing.modelInfo, {});
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const w = screen.priceWeights ?? { a: 1, b: 0.5, c: 3, capMultiplier: 2 };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaved(false);
    const num = (k: string) => Number(f.get(k));
    const ok = await run(async () => {
      await setFloor({ billboardId: screen._id, floorMinor: Math.round(num("floor") * 100) });
      await setWeights({
        billboardId: screen._id,
        a: num("a"),
        b: num("b"),
        c: num("c"),
        capMultiplier: num("cap"),
      });
      return true;
    });
    if (ok) setSaved(true);
  }

  return (
    <section className="live-card">
      <h2>Price</h2>
      <form
        key={`${screen.reserveFloorMinor}:${w.a}:${w.b}:${w.c}:${w.capMultiplier}`}
        className="mt-4 grid grid-cols-2 gap-3"
        onSubmit={onSubmit}
      >
        <Field label="Floor ($)">
          <input name="floor" defaultValue={(screen.reserveFloorMinor / 100).toFixed(2)} inputMode="decimal" className={`${fieldCls} font-mono`} />
        </Field>
        <Field label="Cap (×)">
          <input name="cap" defaultValue={w.capMultiplier} inputMode="decimal" className={`${fieldCls} font-mono`} />
        </Field>
        <Field label="a">
          <input name="a" defaultValue={w.a} inputMode="decimal" className={`${fieldCls} font-mono`} />
        </Field>
        <Field label="b">
          <input name="b" defaultValue={w.b} inputMode="decimal" className={`${fieldCls} font-mono`} />
        </Field>
        <Field label="c" className="col-span-2">
          <input name="c" defaultValue={w.c} inputMode="decimal" className={`${fieldCls} font-mono`} />
        </Field>
        <div className="col-span-2 flex flex-wrap items-center gap-3 pt-1">
          <button type="submit" disabled={busy} className={pillPrimary}>
            Save
          </button>
          {saved && <span className="text-sm text-ok">Saved</span>}
        </div>
        <div className="col-span-2">
          <ErrorLine error={error} />
        </div>
      </form>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-sm text-faint">
          {model ? (
            <>
              Model · <span className="tabular text-fg">{model.samples}</span> windows
            </>
          ) : (
            "No model yet"
          )}
        </p>
        <button type="button" disabled={busy} className={pillSecondary} onClick={() => run(() => trainNow({}))}>
          Train
        </button>
      </div>
    </section>
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
      await create({
        billboardId,
        name,
        startsAt,
        endsAt: startsAt + minutes * MINUTE,
        ...(segment ? { audienceTags: { [segment]: 1 } } : {}),
      });
      return true;
    });
    if (ok) {
      form.reset();
      setDone(name);
    }
  }

  return (
    <section className="live-card">
      <h2>Event</h2>
      <form className="mt-4 grid grid-cols-2 gap-3" onSubmit={onSubmit}>
        <Field label="Name" className="col-span-2">
          <input name="name" required maxLength={80} className={fieldCls} placeholder="Demo day" />
        </Field>
        <Field label="Minutes">
          <input name="minutes" type="number" min={5} max={720} defaultValue={60} className={`${fieldCls} font-mono`} />
        </Field>
        <Field label="Crowd">
          <select name="segment" className={fieldCls} defaultValue="">
            <option value="">Same as screen</option>
            {SEGMENTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="col-span-2 flex flex-wrap items-center gap-3 pt-1">
          <button type="submit" disabled={busy} className={pillPrimary}>
            Add
          </button>
          {done && <span className="text-sm text-ok">Added {done}</span>}
        </div>
        <div className="col-span-2">
          <ErrorLine error={error} />
        </div>
      </form>
    </section>
  );
}

function TopUpPanel() {
  const companies = useQuery(api.companyAgents.hostList, {});
  const topUp = useMutation(api.companyAgents.hostTopUp);
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<string | null>(null);

  return (
    <section className="live-card">
      <h2>Top up</h2>
      {companies === undefined ? null : companies.length === 0 ? (
        <p className="mt-4 text-sm text-faint">No companies yet.</p>
      ) : (
        <ul className="mt-3 max-h-[280px] overflow-y-auto">
          {companies.map((c) => (
            <li key={c.advertiserId} className="live-topup-row">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold tracking-[-0.2px]">{c.company}</p>
                <p className="tabular font-mono text-sm text-faint">
                  {c.balanceMinor === null ? "—" : money(c.balanceMinor)}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                className={pillSecondary}
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
      {done && <p className="mt-3 text-sm text-ok">Requested for {done}</p>}
      <ErrorLine error={error} />
    </section>
  );
}
