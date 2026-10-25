import { describe, expect, test } from "vitest";
import { createPersonTracker, type Box } from "./personTracker";

const FRAME_MS = 33;

function person(x: number, y = 100): Box {
  return { originX: x, originY: y, width: 80, height: 200 };
}

/** Feed `frames` frames of the same boxes starting at `start`; returns total arrivals and the last in-view count. */
function run(tracker: ReturnType<typeof createPersonTracker>, start: number, frames: number, boxes: (i: number) => Box[]) {
  let arrivals = 0;
  let inView = 0;
  for (let i = 0; i < frames; i++) {
    const r = tracker.update(boxes(i), start + i * FRAME_MS);
    arrivals += r.arrivals;
    inView = r.inView;
  }
  return { arrivals, inView, end: start + frames * FRAME_MS };
}

describe("person tracker", () => {
  test("a person standing in view is one arrival", () => {
    const t = createPersonTracker();
    expect(run(t, 0, 90, () => [person(100)])).toMatchObject({ arrivals: 1, inView: 1 });
  });

  test("a one-frame false detection never counts", () => {
    const t = createPersonTracker();
    t.update([person(300)], 0);
    expect(run(t, FRAME_MS, 60, () => [])).toMatchObject({ arrivals: 0, inView: 0 });
  });

  test("a person walking across the frame is one arrival", () => {
    const t = createPersonTracker();
    expect(run(t, 0, 120, (i) => [person(i * 4)]).arrivals).toBe(1);
  });

  test("a person missed for a second, or stepping out and back, is still one arrival", () => {
    const t = createPersonTracker();
    const a = run(t, 0, 30, () => [person(100)]);
    const gap = run(t, a.end, 30, () => []);
    const b = run(t, gap.end, 30, () => [person(110)]);
    expect(a.arrivals + gap.arrivals + b.arrivals).toBe(1);
    expect(gap.inView).toBe(0);
    expect(b.inView).toBe(1);
  });

  test("two people side by side are two arrivals", () => {
    const t = createPersonTracker();
    expect(run(t, 0, 60, () => [person(100), person(190)])).toMatchObject({ arrivals: 2, inView: 2 });
  });

  test("one person leaving as another walks in counts both", () => {
    const t = createPersonTracker();
    const a = run(t, 0, 30, () => [person(50)]);
    const b = run(t, a.end, 30, () => [person(500)]);
    expect(a.arrivals + b.arrivals).toBe(2);
    expect(b.inView).toBe(1);
  });

  test("someone away longer than the memory window counts again", () => {
    const t = createPersonTracker();
    const a = run(t, 0, 30, () => [person(100)]);
    const away = run(t, a.end, 90, () => []);
    const b = run(t, away.end, 30, () => [person(100)]);
    expect(a.arrivals + b.arrivals).toBe(2);
  });
});
