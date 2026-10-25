type RGB = [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const hex = (color: RGB) => "#" + color.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("");
function luminance(color: RGB): number {
  const linear = color.map((channel) => { const c = channel / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
export function contrastRatio(first: string, second: string): number {
  const a = luminance(rgb(first)), b = luminance(rgb(second));
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
/** Preserve the extracted hue while making text legible on the protected surface. */
export function readableAccent(color: string, dark: boolean): string {
  const base = rgb(color), target = dark ? 255 : 0;
  const surface = dark ? "#555963" : "#b2b4b8";
  for (let step = 0; step <= 100; step++) {
    const candidate = hex(base.map((value) => value + (target - value) * step / 100) as RGB);
    if (contrastRatio(candidate, surface) >= 4.5) return candidate;
  }
  return dark ? "#ffffff" : "#000000";
}
/** Quantized population weighted by chroma; ignore transparent pixels rather than treating them as black. */
export function dominantColor(pixels: Uint8ClampedArray): string {
  const buckets = new Map<string, { weight: number; sum: RGB }>();
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    if (alpha < .1) continue;
    const color: RGB = [pixels[i], pixels[i + 1], pixels[i + 2]];
    const chroma = (Math.max(...color) - Math.min(...color)) / 255;
    const weight = alpha * (1 + chroma * 2);
    const key = color.map((value) => Math.floor(value / 32)).join(",");
    const bucket = buckets.get(key) ?? { weight: 0, sum: [0, 0, 0] as RGB };
    bucket.weight += weight;
    color.forEach((value, channel) => { bucket.sum[channel] += value * weight; });
    buckets.set(key, bucket);
  }
  const winner = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
  return winner ? hex(winner.sum.map((value) => value / winner.weight) as RGB) : "#7050ad";
}
export async function extractImageColor(source: string): Promise<string> {
  const image = new Image(); image.src = source; await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Image color sampling unavailable");
  context.drawImage(image, 0, 0, 64, 64);
  return dominantColor(context.getImageData(0, 0, 64, 64).data);
}
