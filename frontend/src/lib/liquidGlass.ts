/** A rounded lens with a flat, clear centre and a curved optical bevel. No screen pixels are captured. */
export interface LensGeometry { width: number; height: number; radius: number }
export const DISPLACEMENT_SCALE = 64;
export const LIQUID_LAYOUT_EVENT = "taskradar:liquid-layout";

/** The inverse sample offset used by SVG feDisplacementMap, in CSS pixels. */
export function lensOffset(x: number, y: number, { width, height, radius }: LensGeometry): [number, number] {
  const r = Math.max(1, Math.min(radius, width / 2, height / 2));
  const px = x - width / 2, py = y - height / 2;
  const qx = Math.abs(px) - (width / 2 - r), qy = Math.abs(py) - (height / 2 - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  const corner = Math.hypot(ox, oy);
  const depth = -(corner + Math.min(Math.max(qx, qy), 0) - r);
  const bevel = Math.min(r * .65, 14);
  if (depth < 0 || depth >= bevel) return [0, 0];
  const nx = corner > .001 ? ox / corner : qx > qy ? 1 : 0;
  const ny = corner > .001 ? oy / corner : qy >= qx ? 1 : 0;
  const edge = 1 - depth / bevel;
  // Snell's law for glass (n = 1.5). The circular bevel tilts the normal at the rim.
  const incidence = Math.asin(Math.min(.98, edge));
  const refraction = Math.asin(Math.sin(incidence) / 1.5);
  const bend = Math.tan(incidence - refraction) * bevel * .5;
  return [-Math.sign(px) * nx * bend, -Math.sign(py) * ny * bend];
}

/** The centre is flat; only edge bands need the curved-glass calculation. Also used off the UI thread. */
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
      const [dx, dy] = flat ? [0, 0] : lensOffset(px, py, geometry);
      data[index] = Math.round(255 * (.5 + dx / DISPLACEMENT_SCALE));
      data[index + 1] = Math.round(255 * (.5 + dy / DISPLACEMENT_SCALE));
      data[index + 2] = 128; data[index + 3] = 255;
    }
  }
  return { width, height, data };
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
