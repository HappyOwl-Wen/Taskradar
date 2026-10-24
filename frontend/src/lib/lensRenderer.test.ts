import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lensMaterial, type LensMaterial } from "./liquidGlass";
import { createLensRenderer } from "./lensRenderer";

vi.mock("./liquidGlass", async original => ({
  ...await original<typeof import("./liquidGlass")>(), lensMaterial: vi.fn(() => ({ displacement: "fallback-map", lighting: "fallback-light" })),
}));

const workers: TestWorker[] = [];
class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { workers.push(this); }
  reply(id: string, material: LensMaterial | null) { this.onmessage?.(new MessageEvent("message", { data: { id, material } })); }
}
const geometry = { width: 300, height: 40, radius: 20 };
const workerMaterial = { displacement: "worker-map", lighting: "worker-light" };
const fallbackMaterial = { displacement: "fallback-map", lighting: "fallback-light" };

beforeEach(() => {
  workers.length = 0; vi.mocked(lensMaterial).mockClear();
  vi.stubGlobal("Worker", TestWorker); vi.stubGlobal("OffscreenCanvas", class {});
});
afterEach(() => vi.unstubAllGlobals());

it("deduplicates in-flight geometry and reuses the result without canvas work on the UI thread", () => {
  const renderer = createLensRenderer(), first = vi.fn(), second = vi.fn(), cached = vi.fn();
  renderer.request("300/40/20", geometry, first);
  renderer.request("300/40/20", geometry, second);
  expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
  workers[0].reply("300/40/20", workerMaterial);
  expect(first).toHaveBeenCalledWith(workerMaterial); expect(second).toHaveBeenCalledWith(workerMaterial);
  renderer.request("300/40/20", geometry, cached);
  expect(cached).toHaveBeenCalledWith(workerMaterial);
  expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
  expect(lensMaterial).not.toHaveBeenCalled();
  renderer.dispose();
});

it("falls back for pending and future geometry if the worker fails", () => {
  const renderer = createLensRenderer(), pending = vi.fn(), next = vi.fn();
  renderer.request("first", geometry, pending);
  workers[0].onerror?.();
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(pending).toHaveBeenCalledWith(fallbackMaterial);
  renderer.request("next", geometry, next);
  expect(next).toHaveBeenCalledWith(fallbackMaterial);
  expect(lensMaterial).toHaveBeenCalledTimes(2);
  renderer.dispose();
});

it("uses the bounded fallback when offscreen rendering is unavailable", () => {
  vi.stubGlobal("OffscreenCanvas", undefined);
  const renderer = createLensRenderer(), result = vi.fn();
  renderer.request("fallback", geometry, result);
  expect(workers).toHaveLength(0);
  expect(lensMaterial).toHaveBeenCalledWith(geometry);
  expect(result).toHaveBeenCalledWith(fallbackMaterial);
  renderer.dispose();
});

it("ignores late worker results after disposal", () => {
  const renderer = createLensRenderer(), result = vi.fn();
  renderer.request("late", geometry, result);
  renderer.dispose(); workers[0].reply("late", workerMaterial);
  renderer.request("new", geometry, result);
  expect(result).not.toHaveBeenCalled();
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
});

it("bounds the geometry cache while preserving recent maps", () => {
  const renderer = createLensRenderer();
  for (let i = 0; i < 97; i++) {
    renderer.request(String(i), geometry, vi.fn()); workers[0].reply(String(i), { displacement: `map-${i}`, lighting: `light-${i}` });
  }
  const recent = vi.fn(); renderer.request("96", geometry, recent);
  expect(recent).toHaveBeenCalledWith({ displacement: "map-96", lighting: "light-96" });
  renderer.request("0", geometry, vi.fn());
  expect(workers[0].postMessage).toHaveBeenCalledTimes(98);
  renderer.dispose();
});
