import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaceLandmarker, FilesetResolver, ObjectDetector, type Detection } from "@mediapipe/tasks-vision";
import { createPersonTracker } from "./personTracker";
import { faceBox, isFacing } from "./attention";

/**
 * People cut off by the frame edge score around 0.3 with this model; one-off false boxes
 * below this are dropped, and the tracker ignores any box that doesn't persist.
 */
const SCORE_THRESHOLD = 0.25;
/** Detection runs every frame; the UI only needs a few updates a second. */
const UI_UPDATE_MS = 200;
/** Head direction is checked a few times a second (the face model is heavier than the person detector). */
const FACE_CHECK_MS = 250;
const MAX_FACES = 10;

export type CounterState =
  | { status: "loading" }
  | { status: "camera" }
  | { status: "error"; message: string }
  | { status: "running"; inView: number; detections: Detection[] };

/** Counts for one window; looking is null when the face model wasn't running for the whole window. */
export type AudienceWindow = { people: number; avgInViewMs: number; lookers: number | null; avgLookingMs: number | null };

/** People in view now as boxes (fractions of the frame), for the live view. No image. */
export type AudienceFrame = {
  boxes: { x: number; y: number; w: number; h: number; looking: boolean }[];
  inView: number;
  looking: number | null;
};

const round3 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

/** What went wrong with the camera, in words an operator can act on. */
function cameraProblem(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "Camera blocked: allow camera access for this site, then reload.";
  if (name === "NotReadableError") return "Camera busy: close other apps or tabs using it, then reload.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found on this device.";
  return err instanceof Error ? err.message : "Camera unavailable";
}

/**
 * Runs person detection on the camera in the browser and tracks each person across
 * frames, so someone is one arrival however long they stay. Frames never leave the
 * device: callers only receive counts. `takeWindow` returns arrivals and peak since the last call.
 *
 * With `attention`, a face model also checks which people face the camera (the screen), and
 * `audience` reports per window (people, time in view, who looked and for how long) and the
 * live boxes.
 */
export function useArrivalCounter(
  video: React.RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  options: { attention?: boolean } = {},
) {
  const [state, setState] = useState<CounterState>({ status: "loading" });
  const tally = useRef({ arrivals: 0, peak: 0, scoreSum: 0, scoreCount: 0 });
  const tracker = useRef(createPersonTracker());
  const facesOn = useRef(false);
  const facesForWindow = useRef(false);
  const attention = options.attention ?? false;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let frame = 0;
    let stream: MediaStream | null = null;
    let detector: ObjectDetector | null = null;
    let faces: FaceLandmarker | null = null;
    let lastUiUpdate = 0;
    let lastFaceCheck = 0;

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
        // Optional: counting works without it, the looking numbers just stay empty.
        if (attention) {
          FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate: "CPU" },
            runningMode: "VIDEO",
            numFaces: MAX_FACES,
            outputFacialTransformationMatrixes: true,
          })
            .then((model) => {
              if (cancelled) return model.close();
              faces = model;
              facesOn.current = true;
            })
            .catch(() => undefined);
        }
        setState({ status: "camera" });
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
        const el = video.current;
        if (!el || cancelled) return;
        el.srcObject = stream;
        await el.play();
        loop();
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: cameraProblem(err) });
      }
    }

    function loop() {
      const el = video.current;
      if (cancelled || !el || !detector) return;
      if (el.readyState >= 2) {
        const now = performance.now();
        const result = detector.detectForVideo(el, now);
        const boxes = result.detections.flatMap((d) => (d.boundingBox ? [d.boundingBox] : []));
        const { arrivals, inView } = tracker.current.update(boxes, now);
        if (faces && now - lastFaceCheck >= FACE_CHECK_MS) {
          lastFaceCheck = now;
          const found = faces.detectForVideo(el, now);
          const facing = found.faceLandmarks.flatMap((points, i) => {
            const matrix = found.facialTransformationMatrixes[i]?.data;
            return matrix && isFacing(matrix) ? [faceBox(points, el.videoWidth, el.videoHeight)] : [];
          });
          tracker.current.markLooking(facing, now);
        }
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
      faces?.close();
      facesOn.current = false;
    };
  }, [enabled, video, attention]);

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

  const audience = useMemo(
    () => ({
      /** Start a new window: counts from now on. */
      startWindow() {
        tracker.current.startWindow(performance.now());
        facesForWindow.current = facesOn.current;
      },
      /** What the camera saw since `startWindow`. */
      windowStats(): AudienceWindow {
        const s = tracker.current.windowStats();
        const looked = facesForWindow.current && facesOn.current;
        return { people: s.people, avgInViewMs: s.avgInViewMs, lookers: looked ? s.lookers : null, avgLookingMs: looked ? s.avgLookingMs : null };
      },
      /** The people in view now, or null before the camera has a picture. */
      liveFrame(): AudienceFrame | null {
        const el = video.current;
        if (!el || !el.videoWidth || !el.videoHeight) return null;
        const live = tracker.current.liveBoxes(performance.now());
        const boxes = live.map((b) => ({
          x: round3(b.originX / el.videoWidth),
          y: round3(b.originY / el.videoHeight),
          w: round3(b.width / el.videoWidth),
          h: round3(b.height / el.videoHeight),
          looking: b.looking,
        }));
        return { boxes, inView: boxes.length, looking: facesOn.current ? boxes.filter((b) => b.looking).length : null };
      },
    }),
    [video],
  );

  return { state, takeWindow, audience };
}
