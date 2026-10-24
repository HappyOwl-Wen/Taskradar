import { lensPixels, type LensGeometry } from "../lib/liquidGlass";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: string; geometry: LensGeometry }>) => void) | null;
  postMessage: (message: { id: string; map: string | null }) => void;
};
scope.onmessage = async ({ data: { id, geometry } }) => {
  try {
    const { width, height, data } = lensPixels(geometry);
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
    if (!context) throw new Error("No offscreen canvas");
    const pixels = context.createImageData(width, height);
    pixels.data.set(data); context.putImageData(pixels, 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    scope.postMessage({ id, map: `data:image/png;base64,${btoa(binary)}` });
  } catch { scope.postMessage({ id, map: null }); }
};
