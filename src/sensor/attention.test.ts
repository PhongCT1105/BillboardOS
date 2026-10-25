import { describe, expect, test } from "vitest";
import { faceBox, headAngles, isFacing } from "./attention";

const rad = (deg: number) => (deg * Math.PI) / 180;

/** A 4x4 column-major transform turning the head `yaw` degrees left/right, then `pitch` degrees up/down. */
function head(yaw: number, pitch: number): number[] {
  const [cy, sy, cp, sp] = [Math.cos(rad(yaw)), Math.sin(rad(yaw)), Math.cos(rad(pitch)), Math.sin(rad(pitch))];
  // R = Ry(yaw) * Rx(pitch), stored by column.
  const r = [
    [cy, sy * sp, sy * cp],
    [0, cp, -sp],
    [-sy, cy * sp, cy * cp],
  ];
  const m = new Array(16).fill(0);
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) m[col * 4 + row] = r[row][col];
  m[15] = 1;
  return m;
}

describe("head direction", () => {
  test("reads yaw and pitch back from the matrix", () => {
    const a = headAngles(head(20, -10));
    expect(a.yaw).toBeCloseTo(20, 5);
    expect(a.pitch).toBeCloseTo(-10, 5);
  });

  test("facing the camera, or turned a little, is looking", () => {
    expect(isFacing(head(0, 0))).toBe(true);
    expect(isFacing(head(-25, 15))).toBe(true);
  });

  test("turned away, side on, or looking at the floor is not", () => {
    expect(isFacing(head(45, 0))).toBe(false);
    expect(isFacing(head(-90, 0))).toBe(false);
    expect(isFacing(head(0, -40))).toBe(false);
    expect(isFacing(head(180, 0))).toBe(false);
  });

  test("a face's box in video pixels", () => {
    expect(faceBox([{ x: 0.25, y: 0.5 }, { x: 0.5, y: 0.75 }, { x: 0.3, y: 0.6 }], 640, 480)).toEqual({
      originX: 160,
      originY: 240,
      width: 160,
      height: 120,
    });
  });
});
