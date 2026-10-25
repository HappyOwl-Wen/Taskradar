import { describe, expect, it } from "vitest";
import { contrastRatio, dominantColor, readableAccent } from "./imagePalette";

describe("image palette", () => {
  it("picks a representative color, ignoring transparent pixels", () => {
    const pixels = new Uint8ClampedArray([
      0, 0, 0, 0, 0, 0, 0, 0, 24, 120, 80, 255, 24, 120, 80, 255, 230, 30, 40, 255,
    ]);
    expect(dominantColor(pixels)).toBe("#187850");
    expect(dominantColor(new Uint8ClampedArray([0, 0, 0, 0]))).toBe("#7050ad");
    expect(dominantColor(new Uint8ClampedArray([240, 240, 240, 255]))).toBe("#f0f0f0");
  });
  it("keeps accents readable on both protected surfaces, including extreme colors", () => {
    for (const color of ["#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff", "#777777", "#ffff00", "#197a65"]) {
      const light = readableAccent(color, false), dark = readableAccent(color, true);
      expect(contrastRatio(light, "#b2b4b8")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(dark, "#555963")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(light, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(dark, "#000000")).toBeGreaterThanOrEqual(4.5);
    }
  });
});
