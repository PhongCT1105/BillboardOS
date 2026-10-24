import { useCallback, useEffect, useRef, useState } from "react";
import { FilesetResolver, ObjectDetector, type Detection } from "@mediapipe/tasks-vision";

/** Frames used to smooth the in-view count so a flickering box isn't counted as a new arrival. */
const SMOOTHING_FRAMES = 9;
const SCORE_THRESHOLD = 0.5;
/** Detection runs every frame; the UI only needs a few updates a second. */
const UI_UPDATE_MS = 200;

export type CounterState =
  | { status: "loading" }
  | { status: "camera" }
  | { status: "error"; message: string }
  | { status: "running"; inView: number; detections: Detection[] };

/**
 * Runs person detection on the camera in the browser. Frames never leave the device:
 * callers only receive counts. `takeWindow` returns arrivals and peak since the last call.
 */
export function useArrivalCounter(video: React.RefObject<HTMLVideoElement | null>, enabled: boolean) {
  const [state, setState] = useState<CounterState>({ status: "loading" });
  const tally = useRef({ arrivals: 0, peak: 0, scoreSum: 0, scoreCount: 0 });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let frame = 0;
    let stream: MediaStream | null = null;
    let detector: ObjectDetector | null = null;
    const recent: number[] = [];
    let stable = 0;
    let lastUiUpdate = 0;

    async function start() {
      try {
        const fileset = await FilesetResolver.forVisionTasks("/mediapipe");
        detector = await ObjectDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "/models/efficientdet_lite0.tflite", delegate: "GPU" },
          runningMode: "VIDEO",
          scoreThreshold: SCORE_THRESHOLD,
          categoryAllowlist: ["person"],
          maxResults: 20,
        });
        if (cancelled) return;
        setState({ status: "camera" });
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        const el = video.current;
        if (!el || cancelled) return;
        el.srcObject = stream;
        await el.play();
        loop();
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : "Camera unavailable" });
      }
    }

    function loop() {
      const el = video.current;
      if (cancelled || !el || !detector) return;
      if (el.readyState >= 2) {
        const result = detector.detectForVideo(el, performance.now());
        const count = result.detections.length;
        recent.push(count);
        if (recent.length > SMOOTHING_FRAMES) recent.shift();
        const smoothed = [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)];
        const w = tally.current;
        // A rise in the smoothed count means new people walked into view.
        if (smoothed > stable) w.arrivals += smoothed - stable;
        stable = smoothed;
        w.peak = Math.max(w.peak, smoothed);
        for (const d of result.detections) {
          w.scoreSum += d.categories[0]?.score ?? 0;
          w.scoreCount += 1;
        }
        const now = performance.now();
        if (now - lastUiUpdate >= UI_UPDATE_MS) {
          lastUiUpdate = now;
          setState({ status: "running", inView: smoothed, detections: result.detections });
        }
      }
      frame = requestAnimationFrame(loop);
    }

    start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
      detector?.close();
    };
  }, [enabled, video]);

  const takeWindow = useCallback(() => {
    const w = tally.current;
    const out = {
      arrivals: w.arrivals,
      peakInView: w.peak,
      confidence: w.scoreCount > 0 ? Math.round((w.scoreSum / w.scoreCount) * 100) / 100 : 0.5,
    };
    tally.current = { arrivals: 0, peak: 0, scoreSum: 0, scoreCount: 0 };
    return out;
  }, []);

  return { state, takeWindow };
}
