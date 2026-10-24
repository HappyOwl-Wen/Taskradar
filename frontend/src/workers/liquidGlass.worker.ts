import { lensPixels, type LensGeometry, type LensMaterial } from "../lib/liquidGlass";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: string; geometry: LensGeometry }>) => void) | null;
  postMessage: (message: { id: string; material: LensMaterial | null }) => void;
};
scope.onmessage = async ({ data: { id, geometry } }) => {
  try {
    const { width, height, data, lighting } = lensPixels(geometry);
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
    if (!context) throw new Error("No offscreen canvas");
    const pixels = context.createImageData(width, height);
    const encode = async (channel: Uint8ClampedArray) => {
      pixels.data.set(channel); context.putImageData(pixels, 0, 0);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let binary = "";
      for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      return `data:image/png;base64,${btoa(binary)}`;
    };
    const displacement = await encode(data);
    scope.postMessage({ id, material: { displacement, lighting: await encode(lighting) } });
  } catch { scope.postMessage({ id, material: null }); }
};
