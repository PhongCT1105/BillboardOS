/** A person box in video pixels (the fields of MediaPipe's BoundingBox we use). */
export type Box = { originX: number; originY: number; width: number; height: number };

/** A box must keep showing up this long before it counts as a person, so one-frame false detections never count. */
const CONFIRM_MS = 300;
/** A counted person can go undetected this long (occluded, a missed frame, half out of view) and still be the same person. */
const FORGET_MS = 2_000;
/** Unconfirmed boxes are dropped sooner, so flicker doesn't pile up tracks. */
const TENTATIVE_FORGET_MS = 300;
/** A counted person stays "in view" this long after their last detection, so a dropped frame doesn't dip the count. */
const IN_VIEW_GRACE_MS = 500;
/** Furthest a person's box centre can move between sightings, as a fraction of their box height. */
const MAX_MOVE = 0.75;
/** Box heights of the same person stay within this ratio between sightings. */
const MAX_SIZE_RATIO = 2;
/** A face check marks its person as looking until a little after the next check, so looking time is continuous between checks. */
const LOOKING_HOLD_MS = 600;
/** A longer gap between frames (a stalled tab) isn't counted as time in view. */
const MAX_FRAME_GAP_MS = 250;
/**
 * Looking for less than this in a window (a glance) doesn't count as having looked: the ad
 * industry's one-second bar for a display ad being seen. Longer than LOOKING_HOLD_MS, so one
 * face check alone never counts.
 */
const MIN_LOOK_MS = 1_000;

type Track = { id: number; box: Box; firstSeen: number; lastSeen: number; counted: boolean; lookingUntil: number };

/** What the camera saw since `startWindow`: unique people, their average time in view, and who looked at the screen. */
export type WindowStats = { people: number; avgInViewMs: number; lookers: number; avgLookingMs: number };

/** A person in view now, for the live view. */
export type LiveBox = Box & { looking: boolean };

/**
 * Follows people across frames so each one is counted once: a person who is
 * missed for a moment, or steps out and back within FORGET_MS, is the same
 * arrival; someone leaving while someone else walks in are two events, not a
 * wash. No appearance matching, so a person away longer than FORGET_MS counts
 * again, and someone entering exactly where another just left may be missed.
 *
 * It also adds up, per person, time in view and time looking at the screen
 * since `startWindow` (looking comes from `markLooking`, fed by a face model).
 */
export function createPersonTracker() {
  let tracks: Track[] = [];
  let nextId = 1;
  let lastUpdate: number | null = null;
  let windowStart = -Infinity;
  /** Per person this window; kept after they leave, until the next window starts. */
  let windowTimes = new Map<number, { inViewMs: number; lookingMs: number }>();

  const inViewAt = (t: Track, now: number) => t.counted && now - t.lastSeen <= IN_VIEW_GRACE_MS;

  function addTime(id: number, inViewMs: number, lookingMs: number) {
    const times = windowTimes.get(id) ?? { inViewMs: 0, lookingMs: 0 };
    times.inViewMs += inViewMs;
    times.lookingMs += lookingMs;
    windowTimes.set(id, times);
  }

  /** Feed one frame's person boxes. Returns new arrivals in this frame and people in view now. */
  function update(boxes: Box[], now: number): { arrivals: number; inView: number } {
    const dt = lastUpdate === null ? 0 : Math.min(Math.max(now - lastUpdate, 0), MAX_FRAME_GAP_MS);
    lastUpdate = now;
    for (const t of tracks) {
      if (inViewAt(t, now)) addTime(t.id, dt, t.lookingUntil >= now ? dt : 0);
    }

    // Pair every track with every nearby, similarly sized box, then take the closest pairs first.
    const pairs: { track: Track; box: Box; distance: number }[] = [];
    for (const track of tracks) {
      for (const box of boxes) {
        const ratio = box.height / track.box.height;
        if (ratio > MAX_SIZE_RATIO || ratio < 1 / MAX_SIZE_RATIO) continue;
        const distance = centreDistance(track.box, box) / track.box.height;
        if (distance <= MAX_MOVE) pairs.push({ track, box, distance });
      }
    }
    pairs.sort((a, b) => a.distance - b.distance);

    const matchedTracks = new Set<Track>();
    const matchedBoxes = new Set<Box>();
    let arrivals = 0;
    for (const { track, box } of pairs) {
      if (matchedTracks.has(track) || matchedBoxes.has(box)) continue;
      matchedTracks.add(track);
      matchedBoxes.add(box);
      track.box = box;
      track.lastSeen = now;
      if (!track.counted && now - track.firstSeen >= CONFIRM_MS) {
        track.counted = true;
        arrivals += 1;
        // They were in view while being confirmed too (only the part inside this window).
        addTime(track.id, now - Math.max(track.firstSeen, windowStart), 0);
      }
    }

    tracks = tracks.filter((t) => now - t.lastSeen <= (t.counted ? FORGET_MS : TENTATIVE_FORGET_MS));
    for (const box of boxes) {
      if (!matchedBoxes.has(box)) tracks.push({ id: nextId++, box, firstSeen: now, lastSeen: now, counted: false, lookingUntil: 0 });
    }

    const inView = tracks.filter((t) => inViewAt(t, now)).length;
    return { arrivals, inView };
  }

  /** Faces turned toward the screen (boxes in the same pixels): each marks the person it belongs to as looking. */
  function markLooking(faces: Box[], now: number): void {
    for (const face of faces) {
      const cx = face.originX + face.width / 2;
      const cy = face.originY + face.height / 2;
      // The smallest person box around the face's centre is the person it belongs to.
      let owner: Track | null = null;
      for (const t of tracks) {
        if (!inViewAt(t, now)) continue;
        const b = t.box;
        const inside = cx >= b.originX && cx <= b.originX + b.width && cy >= b.originY && cy <= b.originY + b.height;
        if (inside && (!owner || b.width * b.height < owner.box.width * owner.box.height)) owner = t;
      }
      if (owner) owner.lookingUntil = now + LOOKING_HOLD_MS;
    }
  }

  /** Start counting a new window: earlier time no longer counts; people already in view count from now. */
  function startWindow(now: number): void {
    windowStart = now;
    windowTimes = new Map();
  }

  /** People seen in view since `startWindow`, how long on average, and how many looked (and for how long, on average). */
  function windowStats(): WindowStats {
    const times = [...windowTimes.values()].filter((t) => t.inViewMs > 0);
    const lookers = times.filter((t) => t.lookingMs >= MIN_LOOK_MS);
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
    return {
      people: times.length,
      avgInViewMs: avg(times.map((t) => t.inViewMs)),
      lookers: lookers.length,
      avgLookingMs: avg(lookers.map((t) => t.lookingMs)),
    };
  }

  /** The people in view now, each with whether they are looking. */
  function liveBoxes(now: number): LiveBox[] {
    return tracks.filter((t) => inViewAt(t, now)).map((t) => ({ ...t.box, looking: t.lookingUntil >= now }));
  }

  return { update, markLooking, startWindow, windowStats, liveBoxes };
}

function centreDistance(a: Box, b: Box): number {
  const dx = a.originX + a.width / 2 - (b.originX + b.width / 2);
  const dy = a.originY + a.height / 2 - (b.originY + b.height / 2);
  return Math.hypot(dx, dy);
}
