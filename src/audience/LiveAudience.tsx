import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Eye, X } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { errorMessage } from "../lib/format";
import { useNow } from "../lib/hooks";

/** The pop-up renews its request this often (the server keeps it for 20 s). */
const RENEW_MS = 10_000;
/** No new boxes for this long: the screen stopped sending. */
const STALE_MS = 3_000;
const TOAST_MS = 8_000;

export type Audience = { people: number; avgInViewMs: number; lookers: number | null; avgLookingMs: number | null };

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** "4:05:30 PM": windows are 30 seconds, so the time needs seconds. */
export function windowTime(ms: number): string {
  return clock.format(ms);
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** "7 in view, avg 18 s · 4 looked at the screen, avg 9 s". */
export function audienceText(a: Audience): string {
  const parts = [a.people > 0 ? `${a.people} in view, avg ${seconds(a.avgInViewMs)}` : "Nobody in view"];
  if (a.lookers !== null && a.people > 0) {
    parts.push(a.lookers > 0 ? `${a.lookers} looked at the screen, avg ${seconds(a.avgLookingMs ?? 0)}` : "nobody looked at the screen");
  }
  return parts.join(" · ");
}

/** Opens the live view of one screen: boxes only, the camera image never leaves the screen. */
export function LiveAudienceButton({ billboardId, screenName, showWindows = false, className }: {
  billboardId: Id<"billboards">;
  screenName: string;
  /** The host also sees the screen's recent windows. */
  showWindows?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className ?? "demo-text-link inline-flex items-center gap-1.5"} onClick={() => setOpen(true)}>
        <Eye size={16} aria-hidden />
        Live audience
      </button>
      {open && <LiveAudienceDialog billboardId={billboardId} screenName={screenName} showWindows={showWindows} onClose={() => setOpen(false)} />}
    </>
  );
}

function LiveAudienceDialog({ billboardId, screenName, showWindows, onClose }: {
  billboardId: Id<"billboards">;
  screenName: string;
  showWindows: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // Unmounting removes it, which closes it without a "close" event; calling close() here would
  // fire onClose and, under StrictMode's double effects, shut the dialog as soon as it opens.
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  // Keep the screen sending while this is open; a payer is refused once its window ends.
  const watch = useMutation(api.liveAudience.watch);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const renew = () =>
      watch({ billboardId }).catch((err) => {
        if (stopped) return;
        setRefused(errorMessage(err));
        clearInterval(timer);
      });
    const timer = setInterval(renew, RENEW_MS);
    void renew();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [watch, billboardId]);

  const frame = useQuery(api.liveAudience.view, { billboardId });
  const now = useNow(1000);
  const live = frame && now - frame.at < STALE_MS;
  const status = refused ?? (frame === undefined ? "Connecting…" : frame === null ? "Waiting for the screen's camera…" : live ? null : "Paused: the screen isn't sending right now.");

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby={titleId}
      className="m-auto w-[min(720px,calc(100vw-32px))] rounded-2xl border border-line bg-panel p-0 text-fg backdrop:bg-black/50"
    >
      <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
        <h2 id={titleId} className="text-[17px] font-semibold">
          Live audience · {screenName}
        </h2>
        <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full hover:bg-raised" aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="flex flex-col gap-3 p-5">
        {/* Boxes alone are decorative (the counts below say it in words); a status message is read out. */}
        <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-[#0d0e10]" aria-hidden={status === null ? true : undefined}>
          {frame?.boxes.map((b, i) => (
            <div
              key={i}
              className={`absolute rounded-md border-2 transition-all duration-300 ${b.looking ? "border-emerald-400 bg-emerald-400/15" : "border-white/60"}`}
              style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, opacity: live ? 1 : 0.4 }}
            >
              {b.looking && <span className="absolute top-1 left-1 rounded bg-emerald-400 px-1.5 py-0.5 text-[11px] font-semibold text-black">looking</span>}
            </div>
          ))}
          {status && <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/70">{status}</p>}
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="text-[15px]" aria-live="polite">
            <span className="tabular font-mono text-2xl">{frame?.inView ?? 0}</span> in view
            {frame?.looking !== null && frame?.looking !== undefined && (
              <>
                {" · "}
                <span className="tabular font-mono text-2xl text-ok">{frame.looking}</span> looking at the screen
              </>
            )}
          </p>
          {live && <span className="text-xs text-muted">Live</span>}
        </div>
        <p className="text-xs text-muted">
          Boxes only: the camera image never leaves the screen. "Looking" means facing the screen (head direction, not eye tracking).
        </p>
        {showWindows && <ScreenWindows billboardId={billboardId} />}
      </div>
    </dialog>
  );
}

/** The host's recent windows on this screen, newest first. */
function ScreenWindows({ billboardId }: { billboardId: Id<"billboards"> }) {
  const rows = useQuery(api.liveAudience.hostWindows, { billboardId, limit: 8 });
  return (
    <section className="border-t border-line pt-3" aria-label="Recent windows">
      <h3 className="mb-2 text-sm font-semibold">Recent windows</h3>
      {rows === undefined ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No windows reported yet. Each 30-second window is counted when it ends.</p>
      ) : (
        <ol className="flex flex-col gap-1.5 text-sm">
          {rows.map((r) => (
            <li key={r.roundId} className="flex flex-wrap gap-x-3">
              <span className="tabular font-mono text-muted">{windowTime(r.spotStartAt)}</span>
              <span className="font-medium">{r.company ?? "House ad"}</span>
              <span className="text-muted">{audienceText(r.audience)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The newest report that arrived while the page was open (not the history it loaded with); clears itself after a few seconds. */
export function useNewReport<T extends { roundId: string }>(rows: T[] | undefined, reported: (row: T) => boolean): [T | null, () => void] {
  const seen = useRef<Set<string> | null>(null);
  const [latest, setLatest] = useState<T | null>(null);
  useEffect(() => {
    if (!rows) return;
    const done = rows.filter(reported);
    if (seen.current === null) {
      seen.current = new Set(done.map((r) => r.roundId));
      return;
    }
    const fresh = done.find((r) => !seen.current!.has(r.roundId));
    for (const r of done) seen.current.add(r.roundId);
    if (fresh) setLatest(fresh);
    // `reported` is a pure filter: only new rows re-run this.
  }, [rows]);
  useEffect(() => {
    if (!latest) return;
    const timer = setTimeout(() => setLatest(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [latest]);
  return [latest, () => setLatest(null)];
}

/** A small notice in the corner; the live region is always there so screen readers announce new reports. */
export function ReportToast({ title, detail, onDismiss }: { title: string | null; detail: string | null; onDismiss: () => void }) {
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 w-[min(380px,calc(100vw-32px))]">
      {title && (
        <div className="fade-in pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-panel p-4 text-fg shadow-lg">
          <Eye size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{title}</p>
            {detail && <p className="mt-0.5 text-sm text-muted">{detail}</p>}
          </div>
          <button type="button" onClick={onDismiss} className="grid h-7 w-7 shrink-0 place-items-center rounded-full hover:bg-raised" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
