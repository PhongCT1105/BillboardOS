import { useCallback, useEffect, useRef, useState } from "react";
import { embedUrl } from "../../convex/lib/youtube";

/**
 * A YouTube ad through YouTube's official embedded player (ADR 0007): autoplay,
 * muted, looped, no controls. We never download or re-host the video. The
 * IFrame API's PLAYING event is the "first frame"; if the API never loads, the
 * iframe's load event plus 5 s stands in for it.
 */

type YTPlayer = { mute(): void; playVideo(): void };
type YTEvent = { target: YTPlayer; data: number };
type YTNamespace = {
  Player: new (el: HTMLIFrameElement, opts: { events: { onReady?: (e: YTEvent) => void; onStateChange?: (e: YTEvent) => void } }) => YTPlayer;
  PlayerState: { PLAYING: number };
};

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_SRC = "https://www.youtube.com/iframe_api";
const FALLBACK_MS = 5_000;
let apiPromise: Promise<YTNamespace> | null = null;

/** Load the IFrame API once per page (safe to call early to warm it). */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = API_SRC;
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error("YouTube IFrame API failed to load"));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

export function YouTubeCreative({
  videoId,
  title,
  onFirstFrame,
}: {
  videoId: string;
  title?: string | null;
  onFirstFrame?: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const fired = useRef(false);
  const callback = useRef(onFirstFrame);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    callback.current = onFirstFrame;
  }, [onFirstFrame]);

  const fire = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    callback.current?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !frame.current) return;
        new YT.Player(frame.current, {
          events: {
            onReady: (e) => {
              e.target.mute();
              e.target.playVideo();
            },
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.PLAYING) fire();
            },
          },
        });
      })
      .catch(() => {
        // The fallback below still reports playback.
      });
    return () => {
      cancelled = true;
    };
  }, [fire]);

  // Fallback: the API never reported PLAYING within 5 s of the iframe loading.
  useEffect(() => {
    if (!loaded) return;
    const id = setTimeout(fire, FALLBACK_MS);
    return () => clearTimeout(id);
  }, [loaded, fire]);

  return (
    <div className="fade-in absolute inset-0 overflow-hidden bg-black">
      {/* 16:9 player scaled to cover the screen, like object-cover. */}
      <iframe
        ref={frame}
        src={embedUrl(videoId, window.location.origin)}
        title={title ? `Advertisement: ${title}` : "Advertisement"}
        allow="autoplay; encrypted-media; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => setLoaded(true)}
        className="pointer-events-none absolute top-1/2 left-1/2 h-[max(100vh,56.25vw)] w-[max(100vw,177.78vh)] -translate-x-1/2 -translate-y-1/2 border-0"
      />
    </div>
  );
}
