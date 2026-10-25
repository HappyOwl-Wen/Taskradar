import { describe, expect, it, vi } from "vitest";
import { DISPLACEMENT_CENTER, DISPLACEMENT_SCALE, lensMap, lensOffset, lensPixels, lensPixelTiles } from "./liquidGlass";

const lens = { width: 320, height: 80, radius: 40 };

describe("liquid glass optical geometry", () => {
  it("reconstructs every original displacement texel from compact tiles without reducing resolution", () => {
    for (const geometry of [
      { width: 986, height: 799, radius: 28 }, { width: 910, height: 146, radius: 22 },
      { width: 219, height: 98, radius: 22 }, { width: 295, height: 338, radius: 20 },
      { width: 244, height: 799, radius: 26 }, { width: 3000, height: 1800, radius: 28 },
    ]) {
      const original = lensPixels(geometry), tiles = lensPixelTiles(geometry, original)!;
      expect(tiles).not.toBeNull();
      const rebuilt = new Uint8ClampedArray(original.data.length);
      for (let i = 0; i < rebuilt.length; i += 4) rebuilt.set([128, 128, 128, 255], i);
      for (const tile of tiles) {
        const x = Math.round(tile.x / geometry.width * original.width), y = Math.round(tile.y / geometry.height * original.height);
        const w = Math.round(tile.width / geometry.width * original.width), h = Math.round(tile.height / geometry.height * original.height);
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
          const source = (Math.min(dy, tile.pixels.height - 1) * tile.pixels.width + Math.min(dx, tile.pixels.width - 1)) * 4;
          rebuilt.set(tile.pixels.data.subarray(source, source + 4), ((y + dy) * original.width + x + dx) * 4);
        }
      }
      expect(rebuilt.every((value, index) => value === original.data[index])).toBe(true);
      expect(tiles.reduce((size, tile) => size + tile.pixels.data.length, 0)).toBeLessThan(original.data.length / 2);
    }
  });
  it("keeps magnifying, compact and non-repeating maps whole", () => {
    expect(lensPixelTiles({ width: 228, height: 54, radius: 27, profile: "liquid" })).toBeNull();
    expect(lensPixelTiles({ width: 32, height: 32, radius: 16 })).toBeNull();
    const geometry = { width: 300, height: 200, radius: 20 }, pixels = lensPixels(geometry);
    pixels.data[(100 * pixels.width + 150) * 4] = 129;
    expect(lensPixelTiles(geometry, pixels)).toBeNull();
    const edge = lensPixels(geometry); edge.data[150 * 4] ^= 1;
    expect(lensPixelTiles(geometry, edge)).toBeNull();
  });
  it("encodes the optical offsets accurately while skipping the flat centre", () => {
    const geometry = { width: 140, height: 110, radius: 16 };
    const { width, height, data } = lensPixels(geometry);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const [dx, dy] = lensOffset(x + .5, y + .5, geometry), index = (y * width + x) * 4;
      expect(data[index]).toBe(Math.round(DISPLACEMENT_CENTER + 255 * dx / DISPLACEMENT_SCALE));
      expect(data[index + 1]).toBe(Math.round(DISPLACEMENT_CENTER + 255 * dy / DISPLACEMENT_SCALE));
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
  it("magnifies the selection's actual contents symmetrically with bounded displacement", () => {
    const bubble = { ...lens, profile: "liquid" as const };
    const left = lensOffset(80, 40, bubble), right = lensOffset(240, 40, bubble);
    expect(left[0]).toBeGreaterThan(0);
    expect(right[0]).toBeCloseTo(-left[0]);
    expect(left[1]).toBe(0);
    const apparentScale = 160 / (160 + right[0] - left[0]);
    expect(apparentScale).toBeGreaterThan(1.02);
    expect(apparentScale).toBeLessThan(1.06);
    expect(Math.abs(lensOffset(80, 40, { ...bubble, width: 2400 })[0])).toBeLessThanOrEqual(6);
    expect(lensOffset(0, 0, bubble)).toEqual([0, 0]);
  });
  it("encodes interior magnification even in a large lens's flat region", () => {
    const bubble = { width: 400, height: 240, radius: 40, profile: "liquid" as const };
    const { width, data } = lensPixels(bubble);
    const left = data[(120 * width + 100) * 4], right = data[(120 * width + 299) * 4];
    expect(left).toBeGreaterThan(DISPLACEMENT_CENTER);
    expect(right).toBeLessThan(DISPLACEMENT_CENTER);
    expect(left + right).toBe(DISPLACEMENT_CENTER * 2);
    expect(lensPixels({ ...bubble, profile: undefined }).data[(120 * width + 100) * 4]).toBe(DISPLACEMENT_CENTER);
  });
  it("gives the selection bubble a deeper optical rim while keeping its centre clear", () => {
    const bubble = { ...lens, profile: "liquid" as const };
    expect(lensOffset(160, 2, bubble)[1]).toBeGreaterThan(lensOffset(160, 2, lens)[1] * 1.8);
    expect(lensOffset(160, 40, bubble)).toEqual([0, 0]);
    expect(lensOffset(160, 78, bubble)[1]).toBeCloseTo(-lensOffset(160, 2, bubble)[1]);
    const { data } = lensPixels(bubble);
    expect(data.every(Number.isFinite)).toBe(true);
    for (let x = 0; x < bubble.width; x += 7) for (let y = 0; y < bubble.height; y += 5)
      for (const offset of lensOffset(x, y, bubble)) expect(Math.abs(offset)).toBeLessThan(DISPLACEMENT_SCALE / 2);
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
