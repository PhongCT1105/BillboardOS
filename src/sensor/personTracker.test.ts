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

/** A face box in the top of a person box from `person(x)`. */
function face(x: number, y = 100): Box {
  return { originX: x + 20, originY: y + 10, width: 40, height: 40 };
}

/** Feed frames for `ms` from `start`, marking the faces from `faces(t)` every 8th frame (about 4 face checks a second). */
function play(tracker: ReturnType<typeof createPersonTracker>, start: number, ms: number, boxes: () => Box[], faces: () => Box[] = () => []) {
  let i = 0;
  for (let now = start; now < start + ms; now += FRAME_MS, i++) {
    tracker.update(boxes(), now);
    if (i % 8 === 0) tracker.markLooking(faces(), now);
  }
  return start + ms;
}

describe("window audience", () => {
  test("one person in view for the whole window: one person, about 30 s in view", () => {
    const t = createPersonTracker();
    t.startWindow(0);
    play(t, 0, 30_000, () => [person(100)]);
    const s = t.windowStats();
    expect(s.people).toBe(1);
    expect(s.avgInViewMs).toBeGreaterThan(29_000);
    expect(s.avgInViewMs).toBeLessThanOrEqual(30_000);
    expect(s.lookers).toBe(0);
  });

  test("averages time in view across people, including someone who left mid-window", () => {
    const t = createPersonTracker();
    t.startWindow(0);
    let now = play(t, 0, 10_000, () => [person(100), person(400)]);
    now = play(t, now, 10_000, () => [person(400)]);
    play(t, now, 10_000, () => []);
    const s = t.windowStats();
    expect(s.people).toBe(2);
    // About 10 s and 20 s in view.
    expect(s.avgInViewMs).toBeGreaterThan(14_000);
    expect(s.avgInViewMs).toBeLessThan(16_000);
  });

  test("a new window forgets earlier time; someone still in view counts from its start", () => {
    const t = createPersonTracker();
    let now = play(t, 0, 20_000, () => [person(100)]);
    t.startWindow(now);
    now = play(t, now, 5_000, () => [person(100)]);
    play(t, now, 25_000, () => []);
    const s = t.windowStats();
    expect(s.people).toBe(1);
    expect(s.avgInViewMs).toBeGreaterThan(4_500);
    expect(s.avgInViewMs).toBeLessThan(6_000);
  });

  test("counts who looked at the screen, and for how long", () => {
    const t = createPersonTracker();
    t.startWindow(0);
    // Both in view for 10 s; only the person at x=100 faces the screen, for the first 6 s.
    let now = play(t, 0, 6_000, () => [person(100), person(400)], () => [face(100)]);
    now = play(t, now, 4_000, () => [person(100), person(400)]);
    const s = t.windowStats();
    expect(s.people).toBe(2);
    expect(s.lookers).toBe(1);
    expect(s.avgLookingMs).toBeGreaterThan(5_500);
    expect(s.avgLookingMs).toBeLessThan(7_000);
  });

  test("a glance (one face check) doesn't count as looking", () => {
    const t = createPersonTracker();
    t.startWindow(0);
    let now = play(t, 0, 1_000, () => [person(100)]);
    t.markLooking([face(100)], now);
    now = play(t, now, 200, () => [person(100)]);
    play(t, now, 5_000, () => [person(100)]);
    expect(t.windowStats().lookers).toBe(0);
  });

  test("a face that isn't inside anyone's box is ignored", () => {
    const t = createPersonTracker();
    t.startWindow(0);
    play(t, 0, 5_000, () => [person(100)], () => [face(600)]);
    expect(t.windowStats().lookers).toBe(0);
  });

  test("the live view lists people in view, marking who is looking", () => {
    const t = createPersonTracker();
    const now = play(t, 0, 2_000, () => [person(100), person(400)], () => [face(400)]);
    const boxes = t.liveBoxes(now - FRAME_MS);
    expect(boxes).toHaveLength(2);
    expect(boxes.filter((b) => b.looking).map((b) => b.originX)).toEqual([400]);
  });
});
