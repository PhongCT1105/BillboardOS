import type { Box } from "./personTracker";

/** A head turned at most this far from the camera, left/right and up/down, counts as looking at the screen. */
const MAX_YAW_DEG = 30;
const MAX_PITCH_DEG = 25;

/**
 * Head direction from MediaPipe's facial transformation matrix (4x4, column-major):
 * degrees left/right (yaw) and up/down (pitch) away from facing the camera.
 */
export function headAngles(matrix: ArrayLike<number>): { yaw: number; pitch: number } {
  // The third column is the face's forward axis in camera space.
  const yaw = (Math.atan2(matrix[8], matrix[10]) * 180) / Math.PI;
  const pitch = (Math.asin(Math.max(-1, Math.min(1, -matrix[9]))) * 180) / Math.PI;
  return { yaw, pitch };
}

/** Facing the camera, which sits on the screen: looking toward the ad (head direction, not eye tracking). */
export function isFacing(matrix: ArrayLike<number>): boolean {
  const { yaw, pitch } = headAngles(matrix);
  return Math.abs(yaw) <= MAX_YAW_DEG && Math.abs(pitch) <= MAX_PITCH_DEG;
}

/** The box around a face's landmarks (normalized 0..1) in video pixels. */
export function faceBox(points: { x: number; y: number }[], width: number, height: number): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { originX: minX * width, originY: minY * height, width: (maxX - minX) * width, height: (maxY - minY) * height };
}
