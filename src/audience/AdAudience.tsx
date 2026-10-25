import { useQuery } from "convex/react";
import { Eye } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import { useNow } from "../lib/hooks";
import { LiveAudienceButton, ReportToast, audienceText, useNewReport, windowTime } from "./LiveAudience";

/** A report normally arrives within seconds of the window's end; later than this, the screen's camera wasn't counting. */
const REPORT_WAIT_MS = 60_000;

/** The advertiser's paid 30-second windows: who the screen's camera saw during each, and the live view while one is on air. */
export function AdAudience() {
  const rows = useQuery(api.liveAudience.myWindows, { limit: 10 });
  const now = useNow(1000);
  const [fresh, dismiss] = useNewReport(rows, (r) => r.audience !== null);
  if (rows === undefined) return null;
  return (
    <section aria-labelledby="ad-audience-heading">
      <div className="demo-section-heading">
        <div>
          <h2 id="ad-audience-heading">Who saw your ads</h2>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="demo-empty">
          <Eye size={28} />
          <h3>No paid windows yet</h3>
          <p>When your agent wins a 30-second window on a screen, the people its camera counted show up here.</p>
        </div>
      ) : (
        <ol className="flex flex-col divide-y divide-line rounded-xl border border-line bg-panel">
          {rows.map((r) => {
            const onAir = r.spotStartAt <= now && now < r.spotEndAt;
            return (
              <li key={r.roundId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p>
                    <span className="tabular font-mono text-muted">{windowTime(r.spotStartAt)}</span> · <strong>{r.screen}</strong>
                    {onAir && <span className="ml-2 rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white">ON AIR</span>}
                  </p>
                  <p className="text-muted">
                    {r.audience
                      ? audienceText(r.audience)
                      : now < r.spotStartAt
                        ? "Up next"
                        : onAir
                          ? "Counting now…"
                          : now < r.spotEndAt + REPORT_WAIT_MS
                            ? "Counting…"
                            : "Not counted (the screen's camera was off)"}
                  </p>
                </div>
                {onAir && <LiveAudienceButton billboardId={r.billboardId} screenName={r.screen} />}
              </li>
            );
          })}
        </ol>
      )}
      <p className="demo-data-note mt-3">
        Counted by the screen's own camera; no video is recorded or sent. "Looked" means facing the screen for at least a second.
      </p>
      <ReportToast
        title={fresh ? `Your window on ${fresh.screen} at ${windowTime(fresh.spotStartAt)} just ended` : null}
        detail={fresh?.audience ? audienceText(fresh.audience) : null}
        onDismiss={dismiss}
      />
    </section>
  );
}
