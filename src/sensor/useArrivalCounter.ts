import { useCallback, useEffect, useRef, useState } from "react";
import { FilesetResolver, ObjectDetector, type Detection } from "@mediapipe/tasks-vision";
import { createPersonTracker } from "./personTracker";

/**
 * People cut off by the frame edge score around 0.3 with this model; one-off false boxes
 * below this are dropped, and the tracker ignores any box that doesn't persist.
 */
const SCORE_THRESHOLD = 0.25;
/** Detection runs every frame; the UI only needs a few updates a second. */
const UI_UPDATE_MS = 200;

export type CounterState =
  | { status: "loading" }
  | { status: "camera" }
  | { status: "error"; message: string }
  | { status: "running"; inView: number; detections: Detection[] };

/**
 * Runs person detection on the camera in the browser and tracks each person across
 * frames, so someone is one arrival however long they stay. Frames never leave the
 * device: callers only receive counts. `takeWindow` returns arrivals and peak since the last call.
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
    const tracker = createPersonTracker();
    let lastUiUpdate = 0;

    async function start() {
      try {
        const fileset = await FilesetResolver.forVisionTasks("/mediapipe");
        detector = await ObjectDetector.createFromOptions(fileset, {
          // CPU: the GPU delegate returned only junk boxes for this model in testing; CPU is fast enough for Lite0.
          baseOptions: { modelAssetPath: "/models/efficientdet_lite0.tflite", delegate: "CPU" },
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
        const now = performance.now();
        const result = detector.detectForVideo(el, now);
        const boxes = result.detections.flatMap((d) => (d.boundingBox ? [d.boundingBox] : []));
        const { arrivals, inView } = tracker.update(boxes, now);
        const w = tally.current;
        w.arrivals += arrivals;
        w.peak = Math.max(w.peak, inView);
        for (const d of result.detections) {
          w.scoreSum += d.categories[0]?.score ?? 0;
          w.scoreCount += 1;
        }
        if (now - lastUiUpdate >= UI_UPDATE_MS) {
          lastUiUpdate = now;
          setState({ status: "running", inView, detections: result.detections });
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
