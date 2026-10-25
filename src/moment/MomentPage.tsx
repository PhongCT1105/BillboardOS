import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ago, money } from "../lib/format";
import { useNow } from "../lib/hooks";
import { SEGMENTS } from "../lib/segments";
import { Card, ErrorLine, Field, Pill, inputCls, primaryBtn, secondaryBtn, useAction } from "../customer/ui";
import { RoundsPanel } from "./RoundsPanel";

type Screen = FunctionReturnType<typeof api.billboards.mine>[number];

const MINUTE = 60_000;

/** Host presenter view: who the audience agent thinks is here, the live sale (Sell now, every answer), events, floor and top-ups. */
export function MomentPage() {
  const screens = useQuery(api.billboards.mine, {});
  const [picked, setPicked] = useState<Id<"billboards"> | null>(null);
  const screen = screens?.find((s) => s._id === picked) ?? screens?.[0] ?? null;
  if (screens === undefined) {
    return (
      <main className="mx-auto max-w-[1400px] px-4 pt-8 md:px-6">
        <div className="h-96 animate-pulse rounded-lg bg-panel" />
      </main>
    );
  }
  if (!screen) {
    return (
      <main className="mx-auto max-w-[1400px] px-4 py-16 md:px-6">
        <p className="text-muted">Pair a screen first (Dashboard, Add a display).</p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-[1400px] px-4 pt-6 pb-20 md:px-6">
      {screens.length > 1 && (
        <select
          aria-label="Screen"
          className="mb-4 rounded-md border border-line bg-panel px-3 py-2 text-sm text-fg"
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
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <FloorPanel screen={screen} />
          <EventPanel billboardId={screen._id} />
          <TopUpPanel />
        </div>
      </div>
    </main>
  );
}

function ScreenHeader({ screen }: { screen: Screen }) {
  const now = useNow(30_000);
  const tags = Object.entries(screen.audienceTags ?? {}).sort((a, b) => b[1] - a[1]);
  const label = (key: string) => SEGMENTS.find((s) => s.key === key)?.label ?? key;
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{screen.name}</h1>
        <Pill tone={screen.deviceStatus === "online" ? "ok" : "danger"}>{screen.deviceStatus}</Pill>
        {!screen.deviceId && <Pill tone="muted">no device paired</Pill>}
      </div>
      <p className="text-sm text-muted">
        {screen.locationLabel}, {screen.city}
      </p>
      <Card className="flex flex-col gap-2">
        <p className="text-xs tracking-widest text-muted uppercase">
          Who is here (audience agent{screen.audienceReadAt ? `, read ${ago(screen.audienceReadAt, now)}` : ", not read yet"})
        </p>
        {screen.audienceSummary && <p className="text-sm text-fg">{screen.audienceSummary}</p>}
        {tags.length > 0 ? (
          <ul className="flex flex-wrap gap-2 text-sm">
            {tags.map(([k, w]) => (
              <li key={k} className="rounded-md border border-line px-2 py-1">
                {label(k)} <span className="tabular font-mono text-muted">{Math.round(w * 100)}%</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Until it's read, every company with an approved ad gets offers.</p>
        )}
      </Card>
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
      await setWeights({ billboardId: screen._id, a: num("a"), b: num("b"), c: num("c"), capMultiplier: num("cap") });
      return true;
    });
    if (ok) setSaved(true);
  }
  return (
    <Card className="lg:col-span-1">
      <h2 className="font-semibold">Price formula</h2>
      <p className="mt-1 text-sm text-muted">Each company's price = a × predicted + b × people in view + c × its brand value (0–1), never below the floor or above the cap.</p>
      <form key={`${screen.reserveFloorMinor}:${w.a}:${w.b}:${w.c}:${w.capMultiplier}`} className="mt-4 grid grid-cols-2 gap-3" onSubmit={onSubmit}>
        <Field label="Floor ($)">
          <input name="floor" defaultValue={(screen.reserveFloorMinor / 100).toFixed(2)} inputMode="decimal" className={`${inputCls} font-mono`} />
        </Field>
        <Field label="Cap (× predicted)">
          <input name="cap" defaultValue={w.capMultiplier} inputMode="decimal" className={`${inputCls} font-mono`} />
        </Field>
        <Field label="a (× predicted)">
          <input name="a" defaultValue={w.a} inputMode="decimal" className={`${inputCls} font-mono`} />
        </Field>
        <Field label="b (¢ per person)">
          <input name="b" defaultValue={w.b} inputMode="decimal" className={`${inputCls} font-mono`} />
        </Field>
        <Field label="c (¢ per brand point)" className="col-span-2">
          <input name="c" defaultValue={w.c} inputMode="decimal" className={`${inputCls} font-mono`} />
        </Field>
        <div className="col-span-2 flex items-center gap-3">
          <button type="submit" disabled={busy} className={primaryBtn}>
            Save
          </button>
          {saved && <span className="text-sm text-emerald-300">Saved</span>}
        </div>
        <div className="col-span-2">
          <ErrorLine error={error} />
        </div>
      </form>
      <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 text-sm">
        <p className="text-xs tracking-widest text-muted uppercase">Price model</p>
        {model ? (
          <p className="text-muted">
            Trained on <span className="tabular font-mono text-fg">{model.samples}</span> windows (<span className="tabular font-mono text-fg">{model.liveSamples}</span> live), typical error{" "}
            <span className="tabular font-mono text-fg">{model.rmseMinor.toFixed(2)}¢</span>, {new Date(model.trainedAt).toLocaleTimeString()}.
          </p>
        ) : (
          <p className="text-muted">No model yet: prices start from the recent average. Run the simulator or let a few windows sell, then train.</p>
        )}
        <button type="button" disabled={busy} className={`${secondaryBtn} self-start`} onClick={() => run(() => trainNow({}))}>
          Train now
        </button>
      </div>
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
      <p className="mt-1 text-sm text-muted">Something happening next to the screen now. It raises the price and starts a sale.</p>
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
      <p className="mt-1 text-sm text-muted">Send $2.00 test USDC from the operator wallet to a company agent's wallet so it can pay. Five top-ups a day per company.</p>
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
