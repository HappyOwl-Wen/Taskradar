import { describe, expect, it } from "vitest";
import { selectionBoxAt, selectionFrames, selectionRefractionFrames, type SelectionBox } from "./liquidMotion";

const from: SelectionBox = { x: 0, y: 0, width: 180, height: 44 };
const values = (frame: Keyframe) => String(frame.transform).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number).slice(1);

describe("liquid selection flow", () => {
  it("moves the leading edge ahead of the tail and mirrors the deformation in reverse", () => {
    const first = { x: 0, y: 0, width: 96, height: 36 }, next = { ...first, x: 192 };
    const forward = selectionBoxAt(first, next, .25), reverse = selectionBoxAt(next, first, .25);
    const leading = (forward.x + forward.width - first.width) / 192, trailing = forward.x / 192;
    expect(leading - trailing).toBeGreaterThan(.1);
    expect(forward.width).toBeGreaterThan(first.width * 1.2);
    expect(forward.width).toBeLessThanOrEqual(first.width * 1.7);
    expect(reverse.x).toBeCloseTo(288 - forward.x - forward.width);
    expect(reverse.width).toBeCloseTo(forward.width);
    expect(reverse.height).toBeCloseTo(forward.height);
  });

  it("narrows across the direction of travel, then swells as the tail catches up", () => {
    const to = { ...from, x: 180 };
    expect(selectionBoxAt(from, to, .25).height).toBeLessThan(from.height * .95);
    expect(selectionBoxAt(from, to, .72).height).toBeGreaterThan(from.height * 1.05);
    expect(selectionBoxAt(from, to, 1)).toEqual(to);
  });

  it("resizes the rail without a travelling tail or size overshoot", () => {
    const to = { ...from, width: 64 };
    for (let offset = 0; offset <= 1; offset += .025) {
      const box = selectionBoxAt(from, to, offset, false);
      expect(box.width).toBeGreaterThanOrEqual(64);
      expect(box.width).toBeLessThanOrEqual(from.width);
      expect(box.height).toBe(from.height);
      expect(box.x).toBe(0); expect(box.y).toBe(0);
    }
  });

  it("keeps a vertical navigation bubble inside the sidebar's side gutters", () => {
    const first = { x: 12, y: 0, width: 208, height: 44 }, next = { ...first, y: 400 };
    for (let offset = 0; offset <= 1; offset += .025) {
      const box = selectionBoxAt(first, next, offset);
      expect(box.x - 4).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width + 4).toBeLessThanOrEqual(232);
    }
  });
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

  it("stretches during travel and limits a long navigation jump's rebound to six pixels", () => {
    const frames = selectionFrames(from, { ...from, y: 800 });
    const y = frames.map((frame) => values(frame)[1]);
    expect(y[0]).toBe(0);
    expect(y.at(-1)).toBe(800);
    expect(Math.max(...y)).toBeGreaterThan(800);
    expect(Math.max(...y)).toBeLessThanOrEqual(806);
    expect(frames.some(frame => values(frame)[4] > 1.02)).toBe(true);
    expect(frames.map(frame => frame.offset)).toEqual([...frames.map(frame => frame.offset)].sort((a, b) => Number(a) - Number(b)));
  });

  it("keeps a stationary selection perfectly still", () => {
    for (const frame of selectionFrames(from, from)) expect(values(frame)).toEqual([0, 0, 0, 1, 1]);
  });

  it("gradually restores clear text before the glass finishes, including an interrupted fade", () => {
    const frames = selectionFrames(from, { ...from, x: 200 });
    const optics = selectionRefractionFrames(frames);
    expect(optics[0].opacity).toBe(0);
    expect(optics[10].opacity).toBe(1);
    const tail = optics.slice(22).map(frame => Number(frame.opacity));
    expect(tail).toEqual([...tail].sort((a, b) => b - a));
    expect(Number(optics[30].opacity)).toBeGreaterThan(0);
    expect(Number(optics[30].opacity)).toBeLessThan(1);
    expect(optics.slice(-3).every(frame => frame.opacity === 0)).toBe(true);
    const interrupted = selectionRefractionFrames(frames, .63);
    expect(interrupted[0].opacity).toBe(.63);
    expect(interrupted.at(-1)!.opacity).toBe(0);
    expect(optics.map(frame => frame.offset)).toEqual(frames.map(frame => frame.offset));
    for (let index = 0; index < frames.length; index++) expect(optics[index].transform).toBe(`${frames[index].transform} translate(-4px, -5px)`);
  });

  it("bounds size rebound when a wide rail shrinks to an icon", () => {
    for (const frame of selectionFrames({ ...from, width: 1200 }, { ...from, width: 40 })) {
      const width = values(frame)[3] * 40;
      expect(width).toBeGreaterThanOrEqual(34);
      expect(width).toBeLessThanOrEqual(1200);
    }
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
