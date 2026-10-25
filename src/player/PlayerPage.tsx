import { useEffect, useRef, useState } from "react";
import { preconnect } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { money } from "../lib/format";
import { useNow } from "../lib/hooks";
import { useArrivalCounter } from "../sensor/useArrivalCounter";
import { YouTubeCreative, loadYouTubeApi } from "./YouTubeCreative";

const TICK_MS = 500;

/** The latest defined value: a re-subscribing query never blanks the screen. */
function useLast<T>(value: T | undefined): T | undefined {
  const last = useRef<T | undefined>(undefined);
  if (value !== undefined) last.current = value;
  return last.current;
}

type Screen = FunctionReturnType<typeof api.player.screenState>;
type Window = Screen["windows"][number];

/**
 * Fullscreen billboard. Back-to-back 30-second windows: each plays the ad
 * that won it once it is paid; otherwise our house ad. A strip shows the
 * next window's live sale. With the camera on, the person detector runs
 * invisibly and reports how many people are in view (it feeds the price); on
 * a paired device it also feeds the live view and each window's audience.
 */
export function PlayerPage({
  billboardId,
  camera = false,
  onPeople,
  device = null,
}: {
  billboardId: Id<"billboards">;
  camera?: boolean;
  onPeople?: (inView: number) => void;
  /** The paired device this page runs on (#/screen); a preview has none and reports nothing. */
  device?: Device | null;
}) {
  const now = useNow(TICK_MS);
  const screen = useLast(useQuery(api.player.screenState, { billboardId }));
  // Creatives approved for this host: preloaded so a paid window starts instantly.
  const ready = useQuery(api.player.readyCreatives, { billboardId });

  const hasYouTube = (ready ?? []).some((c) => c.youtubeVideoId);
  useEffect(() => {
    if (!hasYouTube) return;
    preconnect("https://www.youtube-nocookie.com");
    preconnect("https://i.ytimg.com");
    preconnect("https://www.youtube.com");
    loadYouTubeApi().catch(() => {
      // The player falls back to the iframe load event.
    });
  }, [hasYouTube]);

  // A billboard has no pointer; hide the cursor while this page is open.
  useEffect(() => {
    document.body.style.cursor = "none";
    return () => {
      document.body.style.cursor = "";
    };
  }, []);

  if (screen === undefined) return <div className="min-h-[100dvh] bg-ink" />;

  const onAir = (w: Window) => w.spotStartAt <= now && now < w.spotEndAt;
  const playing = screen.windows.find((w) => w.status === "paid" && onAir(w)) ?? null;
  const paying = playing ? null : (screen.windows.find((w) => w.status === "awarded" && now < w.spotEndAt) ?? null);
  const fileUrl = playing?.creative?.provider === "file" ? ((ready ?? []).find((c) => c.campaignId === playing.campaignId)?.url ?? null) : null;

  return (
    <div className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-ink">
      {playing?.creative?.youtubeVideoId ? (
        <YouTubeCreative key={playing.roundId} videoId={playing.creative.youtubeVideoId} title={playing.creative.title} />
      ) : playing && fileUrl ? (
        <img key={playing.roundId} src={fileUrl} alt={`Advertisement from ${playing.company ?? "a company"}`} className="fade-in absolute inset-0 h-full w-full object-cover" />
      ) : playing ? (
        <div className="fade-in absolute inset-0 grid place-items-center bg-gradient-to-br from-[#1e3a8a] to-[#7c3aed] px-10 text-center">
          <p className="text-[clamp(2rem,6vw,6rem)] leading-[1.05] font-black tracking-tight text-white">{playing.company}</p>
        </div>
      ) : (
        <HouseAd screenName={screen.screenName} paying={paying} />
      )}
      <div aria-hidden className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0">
        {(ready ?? []).map((c) =>
          c.youtubeVideoId ? (
            <img key={c.campaignId} src={c.url} alt="" loading="eager" />
          ) : c.contentType?.startsWith("video/") ? (
            <video key={c.campaignId} src={c.url} preload="auto" muted playsInline />
          ) : (
            <img key={c.campaignId} src={c.url} alt="" loading="eager" />
          ),
        )}
      </div>
      <NextSale screen={screen} now={now} playing={playing} />
      {camera && <AudienceSensor device={device} windows={screen.windows} now={now} onPeople={onPeople} />}
    </div>
  );
}

/** Our own ad: the fallback when nobody bought this window (or the winner is still paying). */
function HouseAd({ screenName, paying }: { screenName: string; paying: Window | null }) {
  return (
    <div className="fade-in max-w-[80vw]">
      <p className="text-[clamp(0.8rem,1.2vw,1.2rem)] tracking-[0.3em] text-muted uppercase">BillboardOS</p>
      <p className="mt-4 text-[clamp(2.5rem,7vw,7rem)] leading-[1.05] font-semibold tracking-tight">
        Your ad here, <span className="text-accent">in 30 seconds.</span>
      </p>
      <p className="mt-6 text-[clamp(1.1rem,2vw,2rem)] text-muted">
        {paying ? `${paying.company} won this window at ${money(paying.priceMinor ?? 0)}; paying over x402…` : `Company agents are bidding for ${screenName} right now.`}
      </p>
    </div>
  );
}

/** The strip along the bottom: who is on now (with proof of payment) and the sale for the next 30 seconds. */
function NextSale({ screen, now, playing }: { screen: Screen; now: number; playing: Window | null }) {
  const b = screen.bidding;
  const left = b ? Math.max(0, Math.ceil((b.closesAt - now) / 1000)) : null;
  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 bg-black/60 px-5 py-2 text-[clamp(0.75rem,1.2vw,1.1rem)] text-fg">
      <span>
        {playing ? (
          <>
            Sponsored · {playing.company} · <span className="tabular font-mono">{money(playing.priceMinor ?? 0)}</span>
            {playing.txShort &&
              (playing.txUrl ? (
                <a href={playing.txUrl} target="_blank" rel="noreferrer" className="tabular ml-2 font-mono text-muted">
                  paid on Base · {playing.txShort}
                </a>
              ) : (
                <span className="tabular ml-2 font-mono text-muted">paid on Base · {playing.txShort}</span>
              ))}
          </>
        ) : (
          <span className="text-muted">{screen.screenName}</span>
        )}
      </span>
      {b && (
        <span className="flex items-center gap-3">
          <span className="rounded-full bg-red-500 px-2 py-0.5 text-[0.8em] font-bold text-white">LIVE SALE</span>
          <span>
            next 30 s · {b.offered} {b.offered === 1 ? "company" : "companies"} · {b.agreed} agreed
          </span>
          <span className="tabular font-mono">{left}s</span>
        </span>
      )}
    </div>
  );
}

type Device = { deviceId: Id<"screenDevices">; deviceKey: string };

/** Live view frames per second while someone watches: 3. */
const LIVE_FRAME_MS = 333;
/** A window is reported only if the camera was counting from (nearly) its start. */
const FROM_START_MS = 2_000;
const RETRY_MS = 3_000;

/**
 * The people counter, with nothing of the camera on screen: the person detector
 * (EfficientDet-Lite0) and a face model run on the camera in the browser. Frames
 * never leave the device. It reports how many people are in view (it feeds the
 * price), sends boxes only while the host or the payer has the live view open,
 * and when each window ends, what the camera saw during it.
 */
function AudienceSensor({ device, windows, now, onPeople }: { device: Device | null; windows: Window[]; now: number; onPeople?: (inView: number) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const { state, audience } = useArrivalCounter(video, true, { attention: true });
  const running = state.status === "running";
  const inView = running ? state.inView : null;
  useEffect(() => {
    if (inView !== null) onPeople?.(inView);
  }, [inView, onPeople]);

  // Live view: a new request (or a renewal) starts the frames; the server says when nobody is watching any more.
  const wantedUntil = useQuery(api.liveAudience.wanted, device ? { deviceId: device.deviceId } : "skip");
  const pushFrame = useMutation(api.liveAudience.pushFrame);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (wantedUntil) setSending(true);
  }, [wantedUntil]);
  useEffect(() => {
    if (!sending || !device || !running) return;
    let stopped = false;
    const timer = setInterval(() => {
      const frame = audience.liveFrame();
      if (!frame) return;
      pushFrame({ ...device, ...frame })
        .then((r) => {
          if (!r.wanted && !stopped) setSending(false);
        })
        .catch(() => undefined);
    }, LIVE_FRAME_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [sending, device, running, audience, pushFrame]);

  // Window report: count each window on air from its start; when it ends, send what the camera saw.
  const reportWindow = useMutation(api.liveAudience.reportWindow);
  const onAir = windows.find((w) => w.spotStartAt <= now && now < w.spotEndAt) ?? null;
  const tracked = useRef<{ roundId: Id<"rounds">; fromStart: boolean } | null>(null);
  useEffect(() => {
    const ended = tracked.current;
    if (ended && ended.roundId !== onAir?.roundId) {
      tracked.current = null;
      if (device && running && ended.fromStart) {
        const report = { ...device, roundId: ended.roundId, ...audience.windowStats() };
        // Reports are idempotent per window, so one retry after a dropped connection is safe.
        reportWindow(report).catch(() => setTimeout(() => void reportWindow(report).catch(() => undefined), RETRY_MS));
      }
    }
    if (onAir && !tracked.current) {
      audience.startWindow();
      tracked.current = { roundId: onAir.roundId, fromStart: running && now - onAir.spotStartAt <= FROM_START_MS };
    }
  }, [onAir, now, running, device, audience, reportWindow]);

  // In the page so the browser keeps decoding the camera, but invisible: the billboard shows only the ad.
  return <video ref={video} muted playsInline aria-hidden className="pointer-events-none fixed top-0 left-0 h-px w-px opacity-0" />;
}
