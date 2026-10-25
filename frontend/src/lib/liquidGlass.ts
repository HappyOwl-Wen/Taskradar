/** Rounded glass with a curved bevel; the liquid selection also gently magnifies its interior. */
export interface LensGeometry { width: number; height: number; radius: number; profile?: "liquid" }
export interface LensTile { x: number; y: number; width: number; height: number; image: string }
export type LensTexture = string | LensTile[];
export const DISPLACEMENT_SCALE = 64;
export const DISPLACEMENT_CENTER = 128;
export const LIQUID_LAYOUT_EVENT = "taskradar:liquid-layout";

/** Every glass material, including native fields and surfaces mounted by third-party portals. */
export const GLASS_SURFACES = [
  ".app-page-material", ".app-topbar", ".sidebar-material", ".sidebar-week", ".nav-drawer",
  ".glass-dialog", ".glass-popover", ".glass-card", ".glass-field:not([data-popup-trigger], .topbar-search)",
  ".glass-segmented", ".glass-outline:not([data-popup-trigger])", ".glass-action:not([data-popup-trigger])",
  ".calendar-toolbar", ".calendar-canvas", ".calendar-unscheduled", ".calendar-filters > label", ".fc-popover",
  ".settings-navigation", ".tasks-list", ".dashboard-lane", ".dashboard-date",
  ".liquid-selection-glass", ".liquid-selection-refraction", ".popup-trigger-glass", ".agent-glass-body", ".timer-alarm-dialog",
  ".glass-switch-thumb", ".glass-toast",
].join(", ");

/** The inverse sample offset used by SVG feDisplacementMap, in CSS pixels. */
export function lensOffset(x: number, y: number, { width, height, radius, profile }: LensGeometry): [number, number] {
  const r = Math.max(1, Math.min(radius, width / 2, height / 2));
  const px = x - width / 2, py = y - height / 2;
  const qx = Math.abs(px) - (width / 2 - r), qy = Math.abs(py) - (height / 2 - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  const corner = Math.hypot(ox, oy);
  const depth = -(corner + Math.min(Math.max(qx, qy), 0) - r);
  const bevel = profile === "liquid" ? Math.min(r * .9, 22) : Math.min(r * .65, 14);
  if (depth < 0) return [0, 0];
  // Inverse sampling towards the centre magnifies the real glyphs, with a six-pixel displacement cap.
  const magnification = profile === "liquid" ? Math.min(.055, 12 / Math.max(width, height, 1)) : 0;
  const mx = -px * magnification || 0, my = -py * magnification || 0;
  if (depth >= bevel) return [mx, my];
  const nx = corner > .001 ? ox / corner : qx > qy ? 1 : 0;
  const ny = corner > .001 ? oy / corner : qy >= qx ? 1 : 0;
  const edge = 1 - depth / bevel;
  // Snell's law for glass (n = 1.5). The circular bevel tilts the normal at the rim.
  const incidence = Math.asin(Math.min(.98, edge));
  const refraction = Math.asin(Math.sin(incidence) / 1.5);
  // A broad, gentle liquid bevel bends glyphs without tearing icons close to the capsule's ends.
  const bend = Math.tan(incidence - refraction) * bevel * (profile === "liquid" ? .4 : .5);
  return [mx - Math.sign(px) * nx * bend, my - Math.sign(py) * ny * bend];
}

/** Static surfaces have a flat centre; a liquid lens magnifies its interior as well. Runs off the UI thread. */
export function lensPixels(geometry: LensGeometry, maxEdge = 512) {
  const ratio = Math.min(1, maxEdge / Math.max(geometry.width, geometry.height));
  const width = Math.max(2, Math.ceil(geometry.width * ratio)), height = Math.max(2, Math.ceil(geometry.height * ratio));
  const data = new Uint8ClampedArray(width * height * 4);
  const rim = Math.min(geometry.radius, geometry.width / 2, geometry.height / 2) + 26;
  for (let y = 0; y < height; y++) {
    const py = (y + .5) / ratio;
    for (let x = 0; x < width; x++) {
      const px = (x + .5) / ratio, index = (y * width + x) * 4;
      const flat = px >= rim && px <= geometry.width - rim && py >= rim && py <= geometry.height - rim;
      const [dx, dy] = flat && geometry.profile !== "liquid" ? [0, 0] : lensOffset(px, py, geometry);
      data[index] = Math.round(DISPLACEMENT_CENTER + 255 * dx / DISPLACEMENT_SCALE);
      data[index + 1] = Math.round(DISPLACEMENT_CENTER + 255 * dy / DISPLACEMENT_SCALE);
      data[index + 2] = 128; data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Lossless nine-slice encoding: only identical rows/columns are stretched. Liquid maps stay intact. */
export function lensPixelTiles(geometry: LensGeometry, pixels = lensPixels(geometry)) {
  const { width: w, height: h, data } = pixels;
  const radius = Math.min(geometry.radius, geometry.width / 2, geometry.height / 2);
  const b = Math.ceil(radius * Math.max(w / geometry.width, h / geometry.height)) + 2;
  // One texel of overlap keeps subpixel clipping from exposing the neutral flood at seams.
  const e = b + 1;
  if (geometry.profile === "liquid" || w <= b * 2 || h <= b * 2 || 4 * e * e + 4 * e >= w * h / 2) return null;
  const regions = [
    [0, 0, e, e, e, e], [w - e, 0, e, e, e, e],
    [0, h - e, e, e, e, e], [w - e, h - e, e, e, e, e],
    [b, 0, 1, e, w - b * 2, e], [b, h - e, 1, e, w - b * 2, e],
    [0, b, e, 1, e, h - b * 2], [w - e, b, e, 1, e, h - b * 2],
  ];
  // Verify the neutral centre and every repeated texel, rather than approximating the optical map.
  for (let y = b; y < h - b; y++) for (let x = b; x < w - b; x++) {
    const i = (y * w + x) * 4;
    if (data[i] !== DISPLACEMENT_CENTER || data[i + 1] !== DISPLACEMENT_CENTER || data[i + 2] !== 128 || data[i + 3] !== 255) return null;
  }
  for (const [x, y, sw, sh, dw, dh] of regions) {
    for (let dy = 0; dy < dh; dy++) for (let dx = 0; dx < dw; dx++) {
      const source = ((y + Math.min(dy, sh - 1)) * w + x + Math.min(dx, sw - 1)) * 4;
      const target = ((y + dy) * w + x + dx) * 4;
      for (let channel = 0; channel < 4; channel++) if (data[source + channel] !== data[target + channel]) return null;
    }
  }
  return regions.map(([x, y, sw, sh, dw, dh]) => {
    const tile = new Uint8ClampedArray(sw * sh * 4);
    for (let row = 0; row < sh; row++) tile.set(data.subarray(((y + row) * w + x) * 4, ((y + row) * w + x + sw) * 4), row * sw * 4);
    return { x: x / w * geometry.width, y: y / h * geometry.height,
      width: dw / w * geometry.width, height: dh / h * geometry.height,
      pixels: { width: sw, height: sh, data: tile } };
  });
}

/** Small synchronous fallback for engines without workers/OffscreenCanvas. */
export function lensMap(geometry: LensGeometry): string | null {
  try {
    const { width, height, data } = lensPixels(geometry, 128);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const pixels = context.createImageData(width, height);
    pixels.data.set(data);
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    // A browser may block canvas rendering; the clear CSS rim still works in that case.
    return null;
  }
}
