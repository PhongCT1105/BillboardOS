import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { errorMessage } from "../lib/format";
import { useNow } from "../lib/hooks";
import { useArrivalCounter } from "./useArrivalCounter";

const SEND_EVERY_MS = 10_000;
const MINUTE = 60_000;

/** Booth camera: counts people on this device and sends only aggregate numbers. */
export function SensorPage({ billboardId }: { billboardId: Id<"billboards"> }) {
  const video = useRef<HTMLVideoElement>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { state, takeWindow } = useArrivalCounter(video, cameraOn);
  const addArrivals = useMutation(api.audience.addArrivals);
  const setUsual = useMutation(api.billboards.setUsualInView);
  const billboards = useQuery(api.billboards.list);
  const baseline = billboards?.find((b) => b._id === billboardId)?.usualInView ?? 3;
  const [baselineDraft, setBaselineDraft] = useState<string>("");

  const now = useNow(1000);
  const atMinute = Math.floor(now / MINUTE) * MINUTE;
  const screen = useQuery(api.player.nowPlaying, { billboardId, atMinute });
  const history = useQuery(api.audience.recentForBillboard, { billboardId });
  const bucket = history?.at(-1);

  // Ship the window's totals on a fixed cadence while the camera runs.
  useEffect(() => {
    if (!cameraOn) return;
    const id = setInterval(async () => {
      const w = takeWindow();
      if (w.arrivals === 0 && w.peakInView === 0) return;
      try {
        await addArrivals({ billboardId, ...w, source: "camera" });
        setLastSent(`${w.arrivals} arrival${w.arrivals === 1 ? "" : "s"}, peak ${w.peakInView} in view`);
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      }
    }, SEND_EVERY_MS);
    return () => clearInterval(id);
  }, [cameraOn, billboardId, addArrivals, takeWindow]);

  async function saveBaseline() {
    const value = Number(baselineDraft);
    if (!Number.isInteger(value) || value < 1) {
      setError("Usually in view must be a whole number of people, at least 1.");
      return;
    }
    try {
      await setUsual({ billboardId, usualInView: value });
      setBaselineDraft("");
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <main className="mx-auto grid max-w-[1400px] grid-cols-1 gap-10 px-4 pt-8 pb-16 md:px-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section aria-label="Camera">
        <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-line bg-panel">
          <video
            ref={video}
            muted
            playsInline
            className={`h-full w-full -scale-x-100 object-cover ${showPreview ? "" : "invisible"}`}
          />
          {state.status === "running" && showPreview && (
            <div className="pointer-events-none absolute inset-0 -scale-x-100">
              {state.detections.map((d, i) =>
                d.boundingBox ? (
                  <div
                    key={i}
                    className="absolute rounded border-2 border-accent"
                    style={{
                      left: `${(d.boundingBox.originX / 640) * 100}%`,
                      top: `${(d.boundingBox.originY / 480) * 100}%`,
                      width: `${(d.boundingBox.width / 640) * 100}%`,
                      height: `${(d.boundingBox.height / 480) * 100}%`,
                    }}
                  />
                ) : null,
              )}
            </div>
          )}
          {cameraOn && state.status === "running" && (
            <div className="pointer-events-none absolute top-3 right-3 rounded-md border border-line bg-ink/80 px-3 py-1.5 text-sm text-muted">
              <span className="tabular font-mono text-2xl text-fg">{state.inView}</span>{" "}
              {state.inView === 1 ? "person" : "people"} in view
            </div>
          )}
          {!cameraOn && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              <div>
                <p className="text-lg font-medium">Count foot traffic near the screen</p>
                <p className="mt-2 max-w-[42ch] text-sm text-muted">
                  Detection runs on this device. Video never leaves it; only people counts are sent.
                </p>
                <button
                  type="button"
                  onClick={() => setCameraOn(true)}
                  className="mt-5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink active:scale-[0.98]"
                >
                  Start camera
                </button>
              </div>
            </div>
          )}
          {cameraOn && (state.status === "loading" || state.status === "camera") && (
            <div className="absolute inset-0 grid place-items-center text-sm text-muted">
              {state.status === "loading" ? "Loading detector" : "Waiting for camera permission"}
            </div>
          )}
          {state.status === "error" && cameraOn && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-danger">{state.message}</div>
          )}
          {cameraOn && !showPreview && (
            <div className="absolute inset-0 grid place-items-center text-sm text-muted">Preview hidden. Still counting.</div>
          )}
        </div>
        {cameraOn && (
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg"
          >
            {showPreview ? "Hide preview" : "Show preview"}
          </button>
        )}
      </section>

      <aside className="flex flex-col gap-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audience sensor</h1>
          <p className="mt-1 text-sm text-muted">{screen?.billboard.name ?? "Loading"}</p>
        </div>
        <dl className="grid grid-cols-2 gap-6">
          <Figure label="In view now" value={state.status === "running" ? String(state.inView) : "None"} />
          <Figure label="Arrivals this 15 min" value={bucket ? String(bucket.countEstimate) : "0"} />
          <Figure label="Source" value={bucket ? bucket.source : "None"} />
        </dl>
        <div className="flex flex-col gap-2 text-sm">
          {lastSent && <p className="text-muted">Last sent: {lastSent}</p>}
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="border-t border-line pt-6">
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-muted">People usually in view of this screen (now {baseline})</span>
            <div className="flex gap-2">
              <input
                inputMode="numeric"
                value={baselineDraft}
                onChange={(e) => setBaselineDraft(e.target.value)}
                placeholder={String(baseline)}
                className="w-28 rounded-md border border-line bg-panel px-3 py-2 text-fg placeholder:text-faint"
              />
              <button
                type="button"
                onClick={saveBaseline}
                disabled={baselineDraft.trim() === ""}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-fg disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </label>
          <p className="mt-2 text-xs text-faint">When the camera sees more people than this, offers go up (up to 3×).</p>
        </div>
      </aside>
    </main>
  );
}

function Figure(props: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{props.label}</dt>
      <dd className="tabular font-mono text-2xl">{props.value}</dd>
    </div>
  );
}
