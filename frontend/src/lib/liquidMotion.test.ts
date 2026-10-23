import { describe, expect, it } from "vitest";
import { selectionFrames, type SelectionBox } from "./liquidMotion";

const from: SelectionBox = { x: 0, y: 0, width: 180, height: 44 };
const values = (frame: Keyframe) => String(frame.transform).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number).slice(1);

describe("liquid selection spring", () => {
  it("starts at the previous visual position and settles exactly on the next selection", () => {
    const to = { x: 80, y: 220, width: 220, height: 40 };
    const frames = selectionFrames(from, to);
    const start = values(frames[0]), end = values(frames.at(-1)!);
    expect(start[0]).toBeCloseTo(0);
    expect(start[1]).toBeCloseTo(0);
    expect(start[3]).toBeCloseTo(180 / 220);
    expect(start[4]).toBeCloseTo(44 / 40);
    expect(end).toEqual([80, 220, 0, 1, 1]);
  });

  it("has a small spring overshoot and caps long-distance bounce", () => {
    const frames = selectionFrames(from, { ...from, y: 800 });
    const y = frames.map((frame) => values(frame)[1]);
    expect(Math.max(...y)).toBeGreaterThan(800);
    expect(Math.max(...y)).toBeLessThan(814);
  });

  it("supports reverse movement and changes in size without invalid transforms", () => {
    const frames = selectionFrames({ x: 600, y: 500, width: 40, height: 50 }, { x: 10, y: 5, width: 200, height: 36 });
    for (const frame of frames) {
      const components = values(frame);
      expect(components.every(Number.isFinite)).toBe(true);
      expect(components[3]).toBeGreaterThan(0);
      expect(components[4]).toBeGreaterThan(0);
    }
  });
});
