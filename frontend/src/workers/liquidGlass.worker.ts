import { lensPixels, lensPixelTiles, type LensGeometry, type LensTexture } from "../lib/liquidGlass";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: string; geometry: LensGeometry }>) => void) | null;
  postMessage: (message: { id: string; map: LensTexture | null }) => void;
};
scope.onmessage = async ({ data: { id, geometry } }) => {
  try {
    const source = lensPixels(geometry);
    const encode = async ({ width, height, data }: typeof source) => {
      const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
      if (!context) throw new Error("No offscreen canvas");
      const pixels = context.createImageData(width, height);
      pixels.data.set(data); context.putImageData(pixels, 0, 0);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let binary = "";
      for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      return `data:image/png;base64,${btoa(binary)}`;
    };
    const tiles = lensPixelTiles(geometry, source);
    const map = tiles ? await Promise.all(tiles.map(async ({ pixels, ...tile }) => ({ ...tile, image: await encode(pixels) }))) : await encode(source);
    scope.postMessage({ id, map });
  } catch { scope.postMessage({ id, map: null }); }
};
