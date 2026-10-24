/** A rounded lens with a flat, clear centre and a curved optical bevel. No screen pixels are captured. */
export interface LensGeometry { width: number; height: number; radius: number; border?: number }
export interface LensMaterial { displacement: string; lighting: string }
export const DISPLACEMENT_SCALE = 64;
export const LIQUID_LAYOUT_EVENT = "taskradar:liquid-layout";
interface SurfaceNormal { depth: number; bevel: number; nx: number; ny: number; nz: number; edge: number }

function surfaceNormal(x: number, y: number, { width, height, radius }: LensGeometry): SurfaceNormal | null {
  const r = Math.max(1, Math.min(radius, width / 2, height / 2));
  const px = x - width / 2, py = y - height / 2;
  const qx = Math.abs(px) - (width / 2 - r), qy = Math.abs(py) - (height / 2 - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  const corner = Math.hypot(ox, oy);
  const depth = -(corner + Math.min(Math.max(qx, qy), 0) - r);
  const bevel = Math.min(r * .85, 26);
  if (depth < 0 || depth >= bevel) return null;
  const nx = corner > .001 ? ox / corner : qx > qy ? 1 : 0;
  const ny = corner > .001 ? oy / corner : qy >= qx ? 1 : 0;
  const edge = Math.min(.98, 1 - depth / bevel);
  return { depth, bevel, nx: Math.sign(px) * nx * edge, ny: Math.sign(py) * ny * edge, nz: Math.sqrt(1 - edge * edge), edge };
}

function sampleOffset(surface: SurfaceNormal | null): [number, number] {
  if (!surface || surface.edge < 1e-6) return [0, 0];
  const { bevel, nx, ny, edge } = surface;
  // Snell's law for glass (n = 1.5). The circular bevel tilts the normal at the rim.
  const incidence = Math.asin(edge);
  const refraction = Math.asin(Math.sin(incidence) / 1.5);
  const bend = Math.tan(incidence - refraction) * bevel * .82;
  return [-nx / edge * bend, -ny / edge * bend];
}

/** The inverse sample offset used by SVG feDisplacementMap, in CSS pixels. */
export function lensOffset(x: number, y: number, geometry: LensGeometry): [number, number] {
  return sampleOffset(surfaceNormal(x, y, geometry));
}

/** Baked curved-rim lighting: a top-left softbox, grazing reflection and a lower transmitted light band. */
function surfaceLight(surface: SurfaceNormal | null): [number, number, number, number] {
  if (!surface) return [0, 0, 0, 0];
  const { depth, bevel, nx, ny, nz, edge } = surface;
  const facing = -nx * .55 - ny * .83;
  const specular = Math.pow(Math.max(0, -nx * .26 - ny * .35 + nz * .9), 28) * .58;
  const fresnel = Math.pow(1 - nz, 3) * (.38 + facing * .22);
  const lip = Math.exp(-Math.pow((depth - 1.1) / 1.15, 2)) * (.28 + Math.max(facing, 0) * .4);
  const lower = Math.max(0, nx * .3 + ny * .8);
  const caustic = Math.exp(-Math.pow((depth / bevel - .58) / .16, 2)) * lower * .32;
  const absorption = Math.exp(-Math.pow((depth / bevel - .24) / .22, 2)) * Math.max(-facing, 0) * .32;
  const fade = Math.min(1, edge / .18);
  const intensity = (specular + fresnel + lip + caustic - absorption) * fade;
  return intensity >= 0
    ? [caustic > .06 ? 220 : 255, caustic > .06 ? 241 : 255, 255, Math.round(Math.min(.82, intensity) * 255)]
    : [23, 38, 66, Math.round(Math.min(.4, -intensity) * 255)];
}

/** The centre is flat; only edge bands need the curved-glass calculation. Also used off the UI thread. */
export function lensPixels(geometry: LensGeometry, maxEdge = 512) {
  const ratio = Math.min(1, maxEdge / Math.max(geometry.width, geometry.height));
  const width = Math.max(2, Math.ceil(geometry.width * ratio)), height = Math.max(2, Math.ceil(geometry.height * ratio));
  const data = new Uint8ClampedArray(width * height * 4);
  const lighting = new Uint8ClampedArray(width * height * 4);
  const border = geometry.border ?? 0;
  const inner = { width: Math.max(1, geometry.width - border * 2), height: Math.max(1, geometry.height - border * 2), radius: Math.max(1, geometry.radius - border) };
  const rim = Math.min(geometry.radius, geometry.width / 2, geometry.height / 2) + 26;
  for (let y = 0; y < height; y++) {
    const py = (y + .5) / ratio;
    for (let x = 0; x < width; x++) {
      const px = (x + .5) / ratio, index = (y * width + x) * 4;
      const flat = px >= rim && px <= geometry.width - rim && py >= rim && py <= geometry.height - rim;
      const normal = flat ? null : surfaceNormal(px, py, geometry);
      const [dx, dy] = sampleOffset(normal);
      data[index] = Math.round(255 * (.5 + dx / DISPLACEMENT_SCALE));
      data[index + 1] = Math.round(255 * (.5 + dy / DISPLACEMENT_SCALE));
      data[index + 2] = 128; data[index + 3] = 255;
      // Lighting lives inside the padding box; it must not extend a scroll container's bounds.
      const lightNormal = border > 0 && !flat ? surfaceNormal((x + .5) / width * inner.width, (y + .5) / height * inner.height, inner) : normal;
      if (lightNormal) lighting.set(surfaceLight(lightNormal), index);
    }
  }
  return { width, height, data, lighting };
}

/** Small synchronous fallback for engines without workers/OffscreenCanvas. */
export function lensMaterial(geometry: LensGeometry): LensMaterial | null {
  try {
    const { width, height, data, lighting } = lensPixels(geometry, 128);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const pixels = context.createImageData(width, height);
    pixels.data.set(data);
    context.putImageData(pixels, 0, 0);
    const displacement = canvas.toDataURL("image/png");
    pixels.data.set(lighting);
    context.putImageData(pixels, 0, 0);
    return { displacement, lighting: canvas.toDataURL("image/png") };
  } catch {
    // A browser may block canvas rendering; the clear CSS rim still works in that case.
    return null;
  }
}
