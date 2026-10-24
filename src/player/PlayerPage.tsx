import { useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { money } from "../lib/format";
import { useNow } from "../lib/hooks";
import { useArrivalCounter } from "../sensor/useArrivalCounter";

const MINUTE = 60_000;
const SEND_EVERY_MS = 10_000;
const TICK_MS = 5_000;

/** The latest defined value: a re-subscribing query never blanks the screen. */
function useLast<T>(value: T | undefined): T | undefined {
  const last = useRef<T | undefined>(undefined);
  if (value !== undefined) last.current = value;
  return last.current;
}

/** Fullscreen billboard. Plays the scheduled creative for the current slot, otherwise a house ad. */
export function PlayerPage({ billboardId, camera = false }: { billboardId: Id<"billboards">; camera?: boolean }) {
  const now = useNow(TICK_MS);
  const atMinute = Math.floor(now / MINUTE) * MINUTE;
  const screenNow = useQuery(api.player.screenState, { billboardId });
  const stateNow = useQuery(api.player.nowPlaying, { billboardId, atMinute });
  const screenLive = useLast(screenNow);
  const state = useLast(stateNow);
  // Creatives approved for this host: preloaded so a paid flash spot starts instantly (ADR 0006).
  const ready = useQuery(api.player.readyCreatives, { billboardId });
  const recordPlayback = useMutation(api.player.recordPlayback);
  const recorded = useRef(new Set<string>());

  const current = state?.current ?? null;
  // Keep showing the creative for the whole slot (the playback receipt flips it to "played").
  const showCreative = (current?.state === "scheduled" || current?.state === "played") && current.creativeUrl;

  // A billboard has no pointer; hide the cursor while this page is open.
  useEffect(() => {
    document.body.style.cursor = "none";
    return () => {
      document.body.style.cursor = "";
    };
  }, []);

  function onCreativeShown() {
    if (!current?.bookingId || recorded.current.has(current.slotId)) return;
    recorded.current.add(current.slotId);
    recordPlayback({ slotId: current.slotId, bookingId: current.bookingId, status: "played" }).catch(() => {
      recorded.current.delete(current.slotId);
    });
  }

  // First load only: nothing to show yet.
  if (state === undefined || screenLive === undefined) {
    return <div className="min-h-[100dvh] bg-ink" />;
  }

  // A paid spot expires on this device's clock; the query never reads time.
  const screen: Screen =
    screenLive.mode === "playing" && screenLive.spotEndAt !== null && now >= screenLive.spotEndAt
      ? ({ ...screenLive, mode: "your_ad_here", nowPlaying: null } as Screen)
      : screenLive;
  const liveMode =
    screen.mode === "announce" || screen.mode === "auction" || screen.mode === "negotiation" || screen.mode === "settling";

  return (
    <div className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-ink">
      {liveMode ? (
        <LiveScreen screen={screen} />
      ) : showCreative ? (
        current.contentType?.startsWith("video/") ? (
          <video
            key={current.slotId}
            src={current.creativeUrl}
            className="fade-in absolute inset-0 h-full w-full object-cover"
            autoPlay
            muted
            loop
            playsInline
            onPlaying={onCreativeShown}
          />
        ) : (
          <img
            key={current.slotId}
            src={current.creativeUrl}
            alt={current.advertiserName ? `Advertisement from ${current.advertiserName}` : "Advertisement"}
            className="fade-in absolute inset-0 h-full w-full object-cover"
            onLoad={onCreativeShown}
          />
        )
      ) : screen.mode === "playing" && screen.nowPlaying ? (
        <div className="fade-in absolute inset-0 grid place-items-center bg-gradient-to-br from-[#1e3a8a] to-[#7c3aed] px-10 text-center">
          <p className="text-[clamp(2rem,6vw,6rem)] leading-[1.05] font-black tracking-tight text-white">{screen.nowPlaying.company}</p>
        </div>
      ) : (
        <div className="fade-in max-w-[80vw]">
          <p className="text-[clamp(2.5rem,7vw,7rem)] leading-[1.05] font-semibold tracking-tight">
            Your ad here, <span className="text-accent">in minutes.</span>
          </p>
          <p className="mt-6 text-[clamp(1.1rem,2vw,2rem)] text-muted">
            {state.houseAd.message}
            {state.houseAd.fromPriceMinor !== null && (
              <>
                {" "}From <span className="tabular font-mono text-fg">{money(state.houseAd.fromPriceMinor)}</span> per 15 minutes.
              </>
            )}
          </p>
        </div>
      )}
      <div aria-hidden className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0">
        {(ready ?? []).map((c) =>
          c.contentType?.startsWith("video/") ? (
            <video key={c.campaignId} src={c.url} preload="auto" muted playsInline />
          ) : (
            <img key={c.campaignId} src={c.url} alt="" loading="eager" />
          ),
        )}
      </div>
      {screen.mode === "playing" && screen.nowPlaying && <ProofStrip playing={screen.nowPlaying} />}
      {!(screen.mode === "playing" && screen.nowPlaying) && (
        <div className="absolute bottom-4 left-5 text-xs text-faint">
          {state.billboard.name}, {state.billboard.city}
        </div>
      )}
      {camera && <CameraCounter billboardId={billboardId} />}
    </div>
  );
}

type Screen = FunctionReturnType<typeof api.player.screenState>;

function ProofStrip({ playing }: { playing: NonNullable<Screen["nowPlaying"]> }) {
  // "Paid" is claimed only with a settlement transaction hash.
  const paid = playing.txShort ? `paid on Base · ${playing.txShort}` : null;
  return (
    <div className="absolute inset-x-0 bottom-0 flex justify-between gap-4 bg-black/60 px-5 py-2 text-[clamp(0.75rem,1.2vw,1.1rem)] text-fg">
      <span>
        Sponsored · {playing.company} · won at <span className="tabular font-mono">{money(playing.wonAtMinor)}</span>
      </span>
      {paid &&
        (playing.txUrl ? (
          <a href={playing.txUrl} target="_blank" rel="noreferrer" className="tabular font-mono">
            {paid}
          </a>
        ) : (
          <span className="tabular font-mono">{paid}</span>
        ))}
    </div>
  );
}

/** Announce, live auction and negotiation: the screen never sits blank between ads. */
function LiveScreen({ screen }: { screen: Screen }) {
  const now = useNow(250);
  const auction = screen.mode === "auction" || screen.mode === "negotiation";
  const left = screen.closesAt ? Math.max(0, Math.ceil((screen.closesAt - now) / 1000)) : 0;

  // The clock visibly jumps when a late bid extends the auction.
  const [bumped, setBumped] = useState(false);
  const lastClose = useRef<number | null>(null);
  useEffect(() => {
    const prev = lastClose.current;
    lastClose.current = screen.closesAt;
    if (prev !== null && screen.closesAt !== null && screen.closesAt > prev) {
      setBumped(true);
      const id = setTimeout(() => setBumped(false), 1200);
      return () => clearTimeout(id);
    }
    setBumped(false);
  }, [screen.closesAt]);

  if (screen.mode === "settling" && screen.nowPlaying) {
    return (
      <div className="fade-in flex h-full min-h-[100dvh] w-full flex-col justify-between p-[clamp(1.25rem,3vw,3rem)]">
        <span className="w-fit rounded-full bg-red-500 px-3 py-1 text-[clamp(0.75rem,1.2vw,1.2rem)] font-bold text-white">SOLD</span>
        <div>
          <p className="text-[clamp(2.2rem,6vw,6rem)] leading-[1.1] font-extrabold tracking-tight">
            {screen.nowPlaying.company}
            <br />
            won at <span className="tabular font-mono">{money(screen.nowPlaying.wonAtMinor)}</span>
          </p>
          <p className="mt-5 text-[clamp(1rem,1.8vw,1.8rem)] text-muted">settling payment on Base…</p>
        </div>
        <span className="text-[clamp(0.7rem,1vw,1rem)] tracking-[0.12em] text-muted uppercase">{screen.screenName}</span>
      </div>
    );
  }

  if (!auction) {
    return (
      <div className="fade-in flex h-full min-h-[100dvh] w-full flex-col justify-between p-[clamp(1.25rem,3vw,3rem)]">
        <span className="text-[clamp(0.7rem,1vw,1rem)] tracking-[0.12em] text-muted uppercase">{screen.screenName} · now</span>
        <div>
          <p className="text-[clamp(2.2rem,6vw,6rem)] leading-[1.1] font-extrabold tracking-tight">
            This screen is available
            <br />
            for the next {screen.minutesLeft} minutes
          </p>
          <p className="mt-5 text-[clamp(1rem,1.8vw,1.8rem)] text-muted">
            {screen.peopleInView !== null && (
              <span className="mr-3 rounded-full bg-emerald-500/20 px-3 py-0.5 text-emerald-400">● camera</span>
            )}
            {screen.peopleInView !== null && `${screen.peopleInView} ${screen.peopleInView === 1 ? "person" : "people"} here now`}
            {screen.eventName && ` · ${screen.eventName} next door`}
          </p>
        </div>
        <p className="text-[clamp(1rem,1.8vw,1.8rem)] text-muted">
          {screen.openingMinor !== null && (
            <>
              Bidding opens at <span className="tabular font-mono text-fg">{money(screen.openingMinor)}</span> · advertisers' agents notified
            </>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="fade-in flex h-full min-h-[100dvh] w-full flex-col justify-between p-[clamp(1.25rem,3vw,3rem)]">
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-red-500 px-3 py-1 text-[clamp(0.75rem,1.2vw,1.2rem)] font-bold text-white">
          {screen.mode === "negotiation" ? "NEGOTIATING" : "LIVE AUCTION"}
        </span>
        <span className="text-[clamp(0.7rem,1vw,1rem)] tracking-[0.12em] text-muted uppercase">
          next {screen.minutesLeft} min · {screen.screenName}
        </span>
      </div>
      <div className="flex items-center gap-[4vw]">
        <ol className="tabular flex flex-1 flex-col gap-2 font-mono text-[clamp(1rem,2.2vw,2.2rem)]">
          {screen.ladder.length === 0 && <li className="text-muted">Waiting for the first bid</li>}
          {screen.ladder.map((row) => (
            <li
              key={`${row.at}-${row.company}-${row.amountMinor}`}
              className={`flex justify-between rounded-md px-3 py-1 ${row.leading ? "bg-accent/25 font-bold" : "bg-white/5"}`}
            >
              <span>{row.company}</span>
              <span>{money(row.amountMinor)}</span>
            </li>
          ))}
        </ol>
        <div className="text-center">
          <div
            className={`tabular font-mono text-[clamp(3rem,9vw,9rem)] leading-none font-black transition-colors ${bumped ? "text-emerald-400" : ""}`}
          >
            {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
          </div>
          <div className="text-[clamp(0.7rem,1vw,1rem)] tracking-[0.12em] text-muted uppercase">{bumped ? "extended" : "left"}</div>
        </div>
      </div>
      <p className="text-[clamp(0.9rem,1.5vw,1.5rem)] text-muted">
        {screen.why ? `Why: ${screen.why}` : ""}
        {screen.openingMinor !== null && (
          <>
            {screen.why ? " · " : ""}opened at <span className="tabular font-mono text-fg">{money(screen.openingMinor)}</span>
          </>
        )}
      </p>
    </div>
  );
}

/** `?camera=1`: this device also counts people, sending only totals, like the sensor page. */
function CameraCounter({ billboardId }: { billboardId: Id<"billboards"> }) {
  const video = useRef<HTMLVideoElement>(null);
  const { isAuthenticated } = useConvexAuth();
  const me = useQuery(api.accounts.me, isAuthenticated ? {} : "skip");
  const isHost = isAuthenticated && me?.accountType === "host";
  // The camera is requested only when counts can be sent (a signed-in host).
  const { takeWindow } = useArrivalCounter(video, isHost);
  const addArrivals = useMutation(api.audience.addArrivals);

  useEffect(() => {
    if (!isHost) return;
    const id = setInterval(async () => {
      const w = takeWindow();
      if (w.arrivals === 0 && w.peakInView === 0) return;
      try {
        await addArrivals({ billboardId, ...w, source: "camera" });
      } catch {
        // Not a workspace member, or offline: the display keeps running.
      }
    }, SEND_EVERY_MS);
    return () => clearInterval(id);
  }, [isHost, billboardId, addArrivals, takeWindow]);

  return (
    <>
      <video ref={video} muted playsInline aria-hidden className="pointer-events-none absolute h-px w-px opacity-0" />
      {!isHost && <div className="absolute top-3 right-4 text-xs text-faint">sign in to count</div>}
    </>
  );
}
