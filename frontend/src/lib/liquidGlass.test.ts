import { describe, expect, it, vi } from "vitest";
import { DISPLACEMENT_SCALE, lensMap, lensOffset, lensPixels } from "./liquidGlass";

const lens = { width: 320, height: 80, radius: 40 };

describe("liquid glass optical geometry", () => {
  it("encodes the optical offsets accurately while skipping the flat centre", () => {
    const geometry = { width: 140, height: 110, radius: 16 };
    const { width, height, data } = lensPixels(geometry);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const [dx, dy] = lensOffset(x + .5, y + .5, geometry), index = (y * width + x) * 4;
      expect(data[index]).toBe(Math.round(255 * (.5 + dx / DISPLACEMENT_SCALE)));
      expect(data[index + 1]).toBe(Math.round(255 * (.5 + dy / DISPLACEMENT_SCALE)));
      expect(data[index + 2]).toBe(128); expect(data[index + 3]).toBe(255);
    }
  });
  it("bounds offscreen and synchronous canvas sizes independently of window resolution", () => {
    const geometry = { width: 6000, height: 3000, radius: 26 };
    expect(lensPixels(geometry).width).toBe(512);
    const fallback = lensPixels(geometry, 128);
    expect(fallback.width).toBe(128); expect(fallback.height).toBe(64);
  });
  it("falls back cleanly when canvas rendering is unavailable", () => {
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => { throw new Error("Canvas blocked"); });
    try { expect(lensMap(lens)).toBeNull(); } finally { context.mockRestore(); }
  });
  it("leaves the clear interior unchanged", () => {
    expect(lensOffset(160, 40, lens)).toEqual([0, 0]);
    expect(lensOffset(80, 40, lens)).toEqual([0, 0]);
  });
  it("bends opposite rims inward by equal distances, without shifting the other axis", () => {
    const top = lensOffset(160, 2, lens), bottom = lensOffset(160, 78, lens);
    expect(top[0]).toBeCloseTo(0);
    expect(top[1]).toBeGreaterThan(2);
    expect(top[1]).toBeLessThan(6);
    expect(bottom[1]).toBeCloseTo(-top[1]);
    expect(lensOffset(2, 40, lens)[0]).toBeGreaterThan(2);
  });
  it("curves both axes at round corners, and leaves outside pixels neutral", () => {
    const [x, y] = lensOffset(14, 14, lens);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(x).toBeCloseTo(y);
    expect(lensOffset(0, 0, lens)).toEqual([0, 0]);
  });
  it("keeps small and wide lenses within the displacement map's channel range", () => {
    for (const geometry of [lens, { width: 28, height: 28, radius: 999 }, { width: 1200, height: 64, radius: 32 }]) {
      for (let x = 0; x <= geometry.width; x += 7) {
        for (let y = 0; y <= geometry.height; y += 5) {
          for (const offset of lensOffset(x, y, geometry)) expect(Math.abs(offset)).toBeLessThan(DISPLACEMENT_SCALE / 2);
        }
      }
    }
  });
});
