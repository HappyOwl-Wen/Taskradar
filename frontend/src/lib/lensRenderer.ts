import { lensMap, type LensGeometry, type LensTexture } from "./liquidGlass";

/** One bounded geometry cache per glass engine; canvas work stays off the UI thread when available. */
export function createLensRenderer() {
  const maps = new Map<string, LensTexture | null>();
  const pending = new Map<string, { geometry: LensGeometry; callbacks: ((map: LensTexture | null) => void)[] }>();
  let worker: Worker | null = null, disposed = false;
  const deliver = (key: string, map: LensTexture | null) => {
    if (disposed) return;
    const job = pending.get(key); pending.delete(key);
    if (maps.size >= 96) maps.delete(maps.keys().next().value!);
    maps.set(key, map);
    job?.callbacks.forEach(callback => callback(map));
  };
  const fallback = () => {
    worker?.terminate(); worker = null;
    for (const [key, job] of pending) deliver(key, lensMap(job.geometry));
  };
  if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    try {
      worker = new Worker(new URL("../workers/liquidGlass.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<{ id: string; map: LensTexture | null }>) => deliver(data.id, data.map);
      worker.onerror = fallback;
    } catch { worker = null; }
  }
  return {
    request(key: string, geometry: LensGeometry, callback: (map: LensTexture | null) => void) {
      if (disposed) return;
      if (maps.has(key)) { callback(maps.get(key)!); return; }
      const existing = pending.get(key);
      if (existing) { existing.callbacks.push(callback); return; }
      pending.set(key, { geometry, callbacks: [callback] });
      if (worker) worker.postMessage({ id: key, geometry });
      else deliver(key, lensMap(geometry));
    },
    dispose() { disposed = true; worker?.terminate(); pending.clear(); maps.clear(); },
  };
}
