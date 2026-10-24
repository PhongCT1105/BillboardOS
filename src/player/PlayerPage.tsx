import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { money } from "../lib/format";
import { useNow } from "../lib/hooks";

const MINUTE = 60_000;

/** Fullscreen billboard. Plays the scheduled creative for the current slot, otherwise a house ad. */
export function PlayerPage({ billboardId }: { billboardId: Id<"billboards"> }) {
  const now = useNow(5_000);
  const atMinute = Math.floor(now / MINUTE) * MINUTE;
  const state = useQuery(api.player.nowPlaying, { billboardId, atMinute });
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

  if (state === undefined) {
    return <div className="min-h-[100dvh] bg-ink" />;
  }

  return (
    <div className="relative grid min-h-[100dvh] place-items-center overflow-hidden bg-ink">
      {showCreative ? (
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
      <div className="absolute bottom-4 left-5 text-xs text-faint">
        {state.billboard.name}, {state.billboard.city}
      </div>
    </div>
  );
}
