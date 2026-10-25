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

type Track = { box: Box; firstSeen: number; lastSeen: number; counted: boolean };

/**
 * Follows people across frames so each one is counted once: a person who is
 * missed for a moment, or steps out and back within FORGET_MS, is the same
 * arrival; someone leaving while someone else walks in are two events, not a
 * wash. No appearance matching, so a person away longer than FORGET_MS counts
 * again, and someone entering exactly where another just left may be missed.
 */
export function createPersonTracker() {
  let tracks: Track[] = [];

  /** Feed one frame's person boxes. Returns new arrivals in this frame and people in view now. */
  function update(boxes: Box[], now: number): { arrivals: number; inView: number } {
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
      }
    }

    tracks = tracks.filter((t) => now - t.lastSeen <= (t.counted ? FORGET_MS : TENTATIVE_FORGET_MS));
    for (const box of boxes) {
      if (!matchedBoxes.has(box)) tracks.push({ box, firstSeen: now, lastSeen: now, counted: false });
    }

    const inView = tracks.filter((t) => t.counted && now - t.lastSeen <= IN_VIEW_GRACE_MS).length;
    return { arrivals, inView };
  }

  return { update };
}

function centreDistance(a: Box, b: Box): number {
  const dx = a.originX + a.width / 2 - (b.originX + b.width / 2);
  const dy = a.originY + a.height / 2 - (b.originY + b.height / 2);
  return Math.hypot(dx, dy);
}
