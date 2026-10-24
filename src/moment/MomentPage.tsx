import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ago, errorMessage, money, timeOfDay } from "../lib/format";
import { useNow } from "../lib/hooks";
import { txUrl } from "../a2a/NegotiationTimeline";

type Live = FunctionReturnType<typeof api.moments.live>;
type Moment = NonNullable<Live["latest"]>;

const MINUTE = 60_000;

/** Host "Live moment" view (ADR 0006): stage-friendly, everything on one screen. */
export function MomentPage() {
  const screens = useQuery(api.billboards.mine, {});
  const [picked, setPicked] = useState<Id<"billboards"> | null>(null);
  const billboardId = picked ?? screens?.[0]?._id ?? null;
  if (screens === undefined) return <main className="mx-auto max-w-[1400px] px-4 pt-8 md:px-6"><div className="h-96 animate-pulse rounded-lg bg-panel" /></main>;
  if (!billboardId) return <main className="mx-auto max-w-[1400px] px-4 py-16 md:px-6"><p className="text-muted">Add a screen first (Workspace).</p></main>;
  return (
    <main className="mx-auto max-w-[1400px] px-4 pt-6 pb-20 md:px-6">
      {screens.length > 1 && (
        <select
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
  const now = useNow(250);
  const atMinute = Math.floor(now / 15_000) * 15_000;
  // Keep showing the last result while a query re-subscribes with new time args (no flicker on stage).
  const live = useSticky(useQuery(api.moments.live, { billboardId, atMinute }));
  const settings = useQuery(api.moments.settings, {});
  const playing = useSticky(useQuery(api.player.nowPlaying, { billboardId, atMinute: Math.floor(now / MINUTE) * MINUTE }));
  const simulate = useMutation(api.moments.simulateCrowd);
  const [people, setPeople] = useState("30");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (live === undefined) return <div className="h-96 animate-pulse rounded-lg bg-panel" />;
  const m = live.latest;
  const active = m !== null && (m.status === "offering" || m.status === "awarded" || m.status === "paid" || m.status === "playing") && m.spotEndAt > now;

  async function run() {
    setBusy(true);
    setNote(null);
    try {
      const r = await simulate({ billboardId, people: Number(people) || 30 });
      if (!r.momentId) setNote(r.reason);
    } catch (err) {
      setNote(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-widest text-accent uppercase">Live moment</p>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{live.screen.name}</h1>
          <p className="mt-1 text-sm text-muted">{live.screen.locationLabel}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {settings?.rehearsalSettlement && (
            <span className="rounded-md border border-amber-400/60 bg-amber-400/10 px-2.5 py-1.5 text-xs font-semibold text-amber-300">
              REHEARSAL settlement ON: blocked payments are simulated
            </span>
          )}
          <label className="flex flex-col gap-1 text-xs text-muted">
            People
            <input
              value={people}
              onChange={(e) => setPeople(e.target.value)}
              inputMode="numeric"
              className="w-20 rounded-md border border-line bg-ink px-2 py-2 font-mono text-sm text-fg"
            />
          </label>
          <button
            type="button"
            onClick={run}
            disabled={busy || active}
            title={active ? "A moment is in progress on this screen" : "Writes a SIMULATED audience reading and runs the seller agent"}
            className="rounded-md border border-amber-400/70 bg-amber-400/15 px-4 py-2 text-sm font-semibold text-amber-200 transition-transform active:scale-[0.98] disabled:opacity-40"
          >
            Simulate crowd (simulated)
          </button>
        </div>
      </header>
      {note && <p className="text-sm text-muted">{note}</p>}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Fact label="Normal traffic" value={`${live.screen.normalTrafficPer15Min} / 15 min`} />
        <Fact
          label="Live crowd (trailing 15 min)"
          value={live.screen.liveCrowd === null ? "no reading" : String(live.screen.liveCrowd)}
          tag={live.screen.liveCrowdSource === "simulated" ? "SIMULATED" : live.screen.liveCrowdSource === "camera" ? "camera" : undefined}
        />
        <Fact
          label="Event"
          value={live.screen.event ? live.screen.event.name : "none"}
          tag={live.screen.event ? `x${live.screen.event.uplift.toFixed(1)}${live.screen.event.source === "seed" ? " · seeded" : ""}` : undefined}
        />
        <Fact label="Relevant viewers" value={m ? `~${m.relevantViewers} ${m.segment}` : "-"} />
      </section>

      {m ? <MomentDetail m={m} now={now} playing={playing ?? null} /> : <Empty />}

      <History rows={live.history} />
      <SettingsPanel />
    </div>
  );
}

function Empty() {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-16 text-center">
      <p className="text-lg">Waiting for a crowd.</p>
      <p className="mt-1 text-sm text-muted">The seller agent fires when relevant viewers cross the threshold. Use the camera sensor, or the labeled simulation.</p>
    </div>
  );
}

function Fact(props: { label: string; value: string; tag?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <p className="text-xs text-muted">{props.label}</p>
      <p className="mt-1 truncate text-xl font-semibold">{props.value}</p>
      {props.tag && <p className={`mt-0.5 text-xs font-medium ${props.tag === "SIMULATED" ? "text-amber-300" : "text-faint"}`}>{props.tag}</p>}
    </div>
  );
}

function Stopwatch({ m, now }: { m: Moment; now: number }) {
  const end = m.firstFrameAt ?? (m.status === "failed" || m.status === "no_takers" ? (m.steps.at(-1)?.at ?? now) : now);
  const ms = Math.max(0, end - m.startedAt);
  const stopped = m.firstFrameAt !== null || m.status === "failed" || m.status === "no_takers";
  const under = m.firstFrameAt !== null && ms < 30_000;
  return (
    <div className="flex flex-col items-start">
      <p className="text-xs tracking-widest text-muted uppercase">{m.firstFrameAt ? "Crowd to first frame" : stopped ? "Stopped" : "Running"}</p>
      <p className={`tabular font-mono text-6xl font-semibold md:text-7xl ${under ? "text-emerald-300" : stopped ? "text-muted" : "text-fg"}`}>
        {(ms / 1000).toFixed(1)}
        <span className="text-3xl">s</span>
      </p>
      {under && <p className="text-sm text-emerald-300">Under 30 seconds</p>}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  offering: "Offering",
  awarded: "Waiting for payment",
  paid: "Paid, scheduled",
  playing: "On screen",
  no_takers: "No takers",
  failed: "Failed",
};

function MomentDetail({ m, now, playing }: { m: Moment; now: number; playing: FunctionReturnType<typeof api.player.nowPlaying> | null }) {
  const windowLeft = Math.max(0, m.offerClosesAt - now);
  const showing = playing?.current?.creativeUrl && (playing.current.state === "scheduled" || playing.current.state === "played") ? playing.current : null;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="flex flex-col gap-6">
        <section className="flex flex-wrap items-end justify-between gap-6 rounded-xl border border-line bg-panel p-6">
          <Stopwatch m={m} now={now} />
          <div className="text-right">
            <p className="text-xs text-muted">{STATUS_LABEL[m.status] ?? m.status}</p>
            <p className="tabular font-mono text-3xl">{m.winner ? money(m.winner.amountMinor) : money(m.priceMinor)}</p>
            <p className="text-xs text-faint">
              {Math.round((m.spotEndAt - m.spotStartAt) / MINUTE)} min, {timeOfDay(m.spotStartAt)} to {timeOfDay(m.spotEndAt)} · ask {money(m.priceMinor)}
            </p>
            {m.status === "offering" && <p className="mt-1 text-sm text-accent">Replies close in {(windowLeft / 1000).toFixed(1)} s</p>}
          </div>
        </section>

        <section className="rounded-xl border border-line bg-panel p-5">
          <p className="text-xs tracking-widest text-muted uppercase">Seller agent reasoning</p>
          <p className="mt-2 text-lg leading-snug">{m.reasoning}</p>
          {m.trigger === "simulated" && <p className="mt-2 text-xs font-semibold text-amber-300">Triggered by a SIMULATED crowd reading</p>}
        </section>

        <section className="rounded-xl border border-line bg-panel p-5">
          <p className="text-xs tracking-widest text-muted uppercase">Offers and replies</p>
          {m.offers.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No eligible customers for this moment.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {m.offers.map((o) => (
                <li key={o.offerId} className="flex flex-wrap items-start justify-between gap-3 border-t border-line pt-3 first:border-t-0 first:pt-0">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {o.company}
                      {o.simulatedAgent && <span className="ml-2 rounded border border-line px-1.5 py-0.5 text-[11px] font-normal text-muted">simulated customer agent</span>}
                    </p>
                    <p className="text-xs text-faint">
                      {Math.round(o.matchScore * 100)}% audience match · ~{o.relevantViewers} relevant · webhook {o.deliveryStatus}
                    </p>
                    {o.replyReasoning && <p className="mt-1 text-sm text-muted">{o.replyReasoning}</p>}
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${o.status === "won" ? "text-emerald-300" : o.status === "defaulted" ? "text-danger" : "text-fg"}`}>{o.status}</p>
                    {o.replyAmountMinor !== null && <p className="tabular font-mono">{money(o.replyAmountMinor)}</p>}
                    {o.repliedAt !== null && <p className="text-xs text-faint">+{((o.repliedAt - m.startedAt) / 1000).toFixed(1)} s</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-5">
          <p className="text-xs tracking-widest text-muted uppercase">Timeline</p>
          <ol className="mt-3 flex flex-col gap-2">
            {m.steps.map((s, i) => (
              <li key={i} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 text-sm">
                <span className="tabular text-right font-mono text-muted">+{((s.at - m.startedAt) / 1000).toFixed(2)}s</span>
                <span>
                  <span className={s.label.includes("REHEARSAL") || s.label.includes("SIMULATED") ? "font-semibold text-amber-300" : "text-fg"}>{s.label}</span>
                  {s.detail && <span className="block text-xs text-faint">{s.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
        <section className="rounded-xl border border-line bg-panel p-5">
          <p className="text-xs tracking-widest text-muted uppercase">Payment</p>
          {m.paymentMode === "x402" && m.paymentTx ? (
            <>
              <p className="mt-2 text-2xl font-semibold text-emerald-300">Paid {m.paidMinor !== null ? money(m.paidMinor) : ""} USDC</p>
              {txUrl(m.paymentNetwork, m.paymentTx) ? (
                <a href={txUrl(m.paymentNetwork, m.paymentTx)!} target="_blank" rel="noreferrer" className="mt-1 block truncate font-mono text-sm text-accent underline-offset-4 hover:underline">
                  {m.paymentTx}
                </a>
              ) : (
                <p className="mt-1 truncate font-mono text-sm text-muted">{m.paymentTx}</p>
              )}
            </>
          ) : m.paymentMode === "rehearsal" ? (
            <>
              <p className="mt-2 text-2xl font-semibold text-amber-300">REHEARSAL (simulated) payment</p>
              <p className="mt-1 text-sm text-muted">No money moved. {m.paymentBlocked ? `Real payment was blocked: ${m.paymentBlocked}.` : ""}</p>
            </>
          ) : m.paymentBlocked ? (
            <>
              <p className="mt-2 text-xl font-semibold text-danger">Not paid</p>
              <p className="mt-1 text-sm text-muted">Payment blocked: {m.paymentBlocked}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">{m.winner ? `Waiting for ${m.winner.company} to pay over x402` : "No winner yet"}</p>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-5">
          <p className="text-xs tracking-widest text-muted uppercase">Now playing</p>
          {showing ? (
            <>
              <div className="mt-3 aspect-video overflow-hidden rounded-lg border border-line bg-ink">
                {showing.contentType?.startsWith("video/") ? (
                  <video src={showing.creativeUrl} muted autoPlay loop playsInline className="h-full w-full object-cover" />
                ) : (
                  <img src={showing.creativeUrl} alt={showing.advertiserName ?? "Advertisement"} className="h-full w-full object-cover" />
                )}
              </div>
              <p className="mt-2 text-sm">{showing.advertiserName}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">House ad</p>
          )}
          <a href={`#/player/${m.billboardId}`} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm text-accent underline-offset-4 hover:underline">
            Open the screen
          </a>
        </section>
      </aside>
    </div>
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
                <td className={`px-4 py-2 ${r.paymentMode === "rehearsal" ? "font-semibold text-amber-300" : ""}`}>
                  {r.paymentMode === "rehearsal" ? "REHEARSAL (simulated)" : r.paymentMode === "x402" ? "x402" : "-"}
                </td>
                <td className="tabular px-4 py-2 text-right font-mono">{r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)} s` : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SettingsPanel() {
  const me = useQuery(api.workspaces.get, {});
  const settings = useQuery(api.moments.settings, {});
  const save = useMutation(api.moments.updateSettings);
  const setRehearsal = useMutation(api.moments.setRehearsalSettlement);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me || !settings) return null;
  const owner = me.myRole === "owner";
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left">
        <span className="font-semibold">Seller agent: moment settings</span>
        <span className="text-sm text-muted">
          {settings.enabled ? "on" : "off"} · {settings.minRelevantViewers}+ relevant · {settings.responseWindowSeconds}s window · {settings.cooldownMinutes} min cooldown
        </span>
      </button>
      {open && (
        <form
          className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-5"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setError(null);
            try {
              await save({
                workspaceId: me.workspaceId,
                enabled: f.get("enabled") === "on",
                minRelevantViewers: Number(f.get("min")),
                cooldownMinutes: Number(f.get("cooldown")),
                responseWindowSeconds: Number(f.get("window")),
                minMatch: Number(f.get("match")) / 100,
              });
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked={settings.enabled} disabled={!owner} /> Detector on
          </label>
          <SettingField name="min" label="Min relevant viewers" value={settings.minRelevantViewers} disabled={!owner} />
          <SettingField name="cooldown" label="Cooldown (min)" value={settings.cooldownMinutes} disabled={!owner} />
          <SettingField name="window" label="Reply window (s)" value={settings.responseWindowSeconds} disabled={!owner} />
          <SettingField name="match" label="Min audience match (%)" value={Math.round(settings.minMatch * 100)} disabled={!owner} />
          {owner && (
            <button type="submit" className="col-span-2 self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink md:col-span-1">
              Save
            </button>
          )}
          {error && <p className="col-span-full text-sm text-danger">{error}</p>}
        </form>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <div className="max-w-[70ch]">
          <p className="text-sm font-semibold text-amber-300">Rehearsal settlement {settings.rehearsalSettlement ? "ON" : "OFF"}</p>
          <p className="text-xs text-muted">
            Only for rehearsing before payment keys exist: when a winner's x402 payment is blocked, settle its hold with a REHEARSAL (simulated) payment. No money moves and it is labeled everywhere. Off by default.
          </p>
        </div>
        {owner ? (
          <button
            type="button"
            onClick={() => void setRehearsal({ workspaceId: me.workspaceId, enabled: !settings.rehearsalSettlement })}
            className="rounded-md border border-amber-400/60 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-400/10"
          >
            Turn {settings.rehearsalSettlement ? "off" : "on"}
          </button>
        ) : (
          <span className="text-xs text-faint">Owners only</span>
        )}
      </div>
    </section>
  );
}

function SettingField(props: { name: string; label: string; value: number; disabled: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {props.label}
      <input name={props.name} defaultValue={props.value} disabled={props.disabled} inputMode="numeric" className="rounded-md border border-line bg-ink px-2 py-1.5 font-mono text-sm text-fg" />
    </label>
  );
}

/** The latest defined value of a query result. */
function useSticky<T>(value: T | undefined): T | undefined {
  const last = useRef<T | undefined>(value);
  if (value !== undefined) last.current = value;
  return value ?? last.current;
}
