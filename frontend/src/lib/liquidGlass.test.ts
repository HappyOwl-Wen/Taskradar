import { describe, expect, it, vi } from "vitest";
import { DISPLACEMENT_SCALE, lensMaterial, lensOffset, lensPixels } from "./liquidGlass";

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
    try { expect(lensMaterial(lens)).toBeNull(); } finally { context.mockRestore(); }
  });
  it("leaves the clear interior unchanged", () => {
    expect(lensOffset(160, 40, lens)).toEqual([0, 0]);
    expect(lensOffset(80, 40, lens)).toEqual([0, 0]);
  });
  it("keeps the lighting transparent across the clear centre and outside the rounded lens", () => {
    const { width, lighting } = lensPixels(lens);
    for (const [x, y] of [[160, 40], [80, 40], [0, 0]]) {
      const index = (y * width + x) * 4;
      expect(Array.from(lighting.subarray(index, index + 4))).toEqual([0, 0, 0, 0]);
    }
  });
  it("lights the upper bevel and gives the lower bevel a dark body and an inner caustic", () => {
    const { width, lighting } = lensPixels(lens);
    const pixel = (x: number, y: number) => Array.from(lighting.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
    expect(pixel(160, 1)[3]).toBeGreaterThan(pixel(160, 78)[3] + 60);
    const lowerBody = pixel(160, 72), caustic = pixel(160, 64);
    expect(lowerBody[0]).toBeLessThan(70); expect(lowerBody[3]).toBeGreaterThan(10);
    expect(caustic[2]).toBe(255); expect(caustic[0]).toBeGreaterThan(180); expect(caustic[3]).toBeGreaterThan(10);
  });
  it("bends opposite rims inward by equal distances, without shifting the other axis", () => {
    const top = lensOffset(160, 2, lens), bottom = lensOffset(160, 78, lens);
    expect(top[0]).toBeCloseTo(0);
    expect(top[1]).toBeGreaterThan(8);
    expect(bottom[1]).toBeCloseTo(-top[1]);
    expect(lensOffset(2, 40, lens)[0]).toBeGreaterThan(8);
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
