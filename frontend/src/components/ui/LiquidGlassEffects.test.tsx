import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DISPLACEMENT_CENTER, DISPLACEMENT_SCALE, LIQUID_LAYOUT_EVENT, lensMap } from "@/lib/liquidGlass";
import { LiquidGlassEffects } from "./LiquidGlassEffects";

vi.mock("@/lib/liquidGlass", async (original) => ({
  ...await original<typeof import("@/lib/liquidGlass")>(),
  lensMap: vi.fn(() => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("installs worker tiles before centering and replaces them cleanly after a resize", async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome/140");
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  let resized!: () => void;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} unobserve() {} disconnect() {} });
  const worker = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn(), terminate: vi.fn() };
  vi.stubGlobal("Worker", vi.fn(function () { return worker; }));
  vi.stubGlobal("OffscreenCanvas", class {});
  let width = 300;
  const panel = document.createElement("div"); panel.className = "glass-card";
  Object.defineProperties(panel, { offsetWidth: { get: () => width }, offsetHeight: { value: 200 } });
  document.body.append(panel);
  const mounted = render(<LiquidGlassEffects />);
  const reply = (map: unknown) => worker.onmessage!(new MessageEvent("message", { data: { id: worker.postMessage.mock.calls.at(-1)![0].id, map } }));
  reply([{ x: 0, y: 0, width: 20, height: 20, image: "tile.png" }]);
  const filter = document.querySelector(".liquid-filter-definitions filter")!;
  expect(filter.querySelector("feMerge")).toHaveAttribute("result", "normal-map");
  expect(filter.querySelector("feMerge")!.nextElementSibling).toBe(filter.querySelector("feComponentTransfer"));
  expect(filter.querySelectorAll("feMergeNode")).toHaveLength(2);
  expect(filter.querySelectorAll("feImage")[1]).toHaveAttribute("href", "tile.png");
  expect(panel).toHaveAttribute("data-liquid-optics", "true");
  await act(async () => { width = 320; resized(); vi.advanceTimersByTime(75); });
  reply("whole-map.png");
  expect(filter.querySelector("feMerge")).toBeNull();
  expect(filter.querySelector("feFlood")).toBeNull();
  expect(filter.querySelectorAll("feImage")).toHaveLength(1);
  expect(filter.querySelector("feImage")).toHaveAttribute("href", "whole-map.png");
  mounted.unmount(); panel.remove();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("measures only changed lenses and ignores text updates while retaining resize and discovery", async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome/140");
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  let resized!: () => void;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
  const host = document.createElement("div");
  const widths = Array.from({ length: 40 }, () => {
    const panel = document.createElement("section"); panel.className = "glass-card";
    const width = vi.fn(() => 300);
    Object.defineProperties(panel, { offsetWidth: { get: width }, offsetHeight: { value: 200 } });
    panel.textContent = "Task"; host.append(panel);
    return width;
  });
  const lens = document.createElement("span"); lens.className = "liquid-selection-glass";
  let lensWidth = 140;
  Object.defineProperties(lens, { offsetWidth: { get: () => lensWidth }, offsetHeight: { value: 36 } });
  host.append(lens); document.body.append(host);
  const mounted = render(<LiquidGlassEffects />);
  await act(async () => { vi.advanceTimersByTime(100); });
  widths.forEach(width => width.mockClear());
  const filters = document.querySelectorAll(".liquid-filter-definitions filter").length;
  await act(async () => {
    lensWidth = 180;
    document.dispatchEvent(new CustomEvent(LIQUID_LAYOUT_EVENT, { detail: [lens] }));
    host.firstElementChild!.textContent = "Updated task";
  });
  await act(async () => { vi.advanceTimersByTime(100); });
  expect(widths.every(width => width.mock.calls.length === 0)).toBe(true);
  expect(document.querySelectorAll(".liquid-filter-definitions filter")).toHaveLength(filters);
  expect(lensMap).toHaveBeenCalledWith({ width: 180, height: 36, radius: 18, profile: "liquid" });
  expect(host.firstElementChild).toHaveAttribute("data-liquid-optics", "true");
  await act(async () => { resized(); vi.advanceTimersByTime(75); });
  expect(widths.every(width => width.mock.calls.length === 1)).toBe(true);

  // A targeted layout event must not cancel an already pending full discovery pass.
  const added = document.createElement("div"); added.className = "glass-card";
  Object.defineProperties(added, { offsetWidth: { value: 200 }, offsetHeight: { value: 100 } });
  await act(async () => { host.append(added); });
  await act(async () => {
    document.dispatchEvent(new CustomEvent(LIQUID_LAYOUT_EVENT, { detail: [lens] }));
    vi.advanceTimersByTime(75);
  });
  expect(added).toHaveAttribute("data-liquid-optics", "true");
  mounted.unmount(); host.remove();
});

it("prepares cached or fallback refraction for a portalled menu without waiting for resize debounce", async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome/140");
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const mounted = render(<LiquidGlassEffects />);
  const portal = document.createElement("div");
  const menu = document.createElement("div");
  menu.className = "glass-popover motion-popover";
  menu.dataset.state = "open";
  Object.defineProperties(menu, { offsetWidth: { value: 224 }, offsetHeight: { value: 160 } });
  portal.append(menu);

  // Keep fake time at zero: only MutationObserver microtasks, no 75 ms optical resize timer.
  await act(async () => { document.body.append(portal); });
  expect(menu.style.getPropertyValue("--liquid-filter")).toMatch(/^url\("#liquid-/);
  expect(menu).toHaveAttribute("data-liquid-optics", "true");
  expect(lensMap).toHaveBeenCalledWith({ width: 224, height: 160, radius: 20 });
  expect(document.querySelector(".liquid-filter-definitions feImage")).toHaveAttribute("href", vi.mocked(lensMap).mock.results.at(-1)!.value);
  const displacement = document.querySelector(".liquid-filter-definitions feDisplacementMap")!;
  const centering = document.querySelector(".liquid-filter-definitions feComponentTransfer")!;
  expect(displacement.getAttribute("in2")).toBe(centering.getAttribute("result"));
  for (const channel of ["feFuncR", "feFuncG"]) {
    const intercept = Number(centering.querySelector(channel)!.getAttribute("intercept"));
    expect(DISPLACEMENT_SCALE * (DISPLACEMENT_CENTER / 255 + intercept - .5)).toBe(0);
  }

  mounted.unmount();
  expect(menu.style.getPropertyValue("--liquid-filter")).toBe("");
  expect(menu).not.toHaveAttribute("data-liquid-optics");
  portal.remove();
});

it("cleans up a surface that loses its glass class without being removed from the page", async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome/140");
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const panel = document.createElement("div"); panel.className = "glass-card";
  Object.defineProperties(panel, { offsetWidth: { value: 600 }, offsetHeight: { value: 400 } });
  document.body.append(panel);
  const mounted = render(<LiquidGlassEffects />);
  expect(panel).toHaveClass("liquid-refractive");
  await act(async () => { panel.classList.remove("glass-card"); });
  await act(async () => { vi.advanceTimersByTime(75); });
  expect(panel).not.toHaveClass("liquid-refractive");
  expect(panel.style.getPropertyValue("--liquid-filter")).toBe("");
  expect(panel).not.toHaveAttribute("data-liquid-optics");
  expect(document.querySelectorAll(".liquid-filter-definitions filter")).toHaveLength(0);
  mounted.unmount(); panel.remove();
});

it("uses the same material for calendar panels, native fields, switches and notification portals", () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome/140");
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const host = document.createElement("div");
  const classes = ["calendar-canvas", "calendar-unscheduled", "fc-popover", "glass-field", "glass-switch-thumb", "glass-toast"];
  const surfaces = classes.map(className => {
    const element = document.createElement(className === "glass-field" ? "input" : "div");
    element.className = className;
    Object.defineProperties(element, { offsetWidth: { value: 140 }, offsetHeight: { value: 36 } });
    host.append(element); return element;
  });
  document.body.append(host);
  const mounted = render(<LiquidGlassEffects />);
  for (const element of surfaces) {
    expect(element).toHaveAttribute("data-liquid-surface");
    expect(element.style.getPropertyValue("--liquid-filter")).toMatch(/^url\("#liquid-/);
  }
  mounted.unmount();
  for (const element of surfaces) expect(element).not.toHaveAttribute("data-liquid-surface");
  host.remove();
});

it("retains CSS glass when SVG backdrop filters are unsupported", () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Safari/605.1");
  vi.stubGlobal("CSS", { supports: () => false });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const panel = document.createElement("div"); panel.className = "glass-card";
  Object.defineProperties(panel, { offsetWidth: { value: 600 }, offsetHeight: { value: 400 } });
  document.body.append(panel);
  const mounted = render(<LiquidGlassEffects />);
  expect(panel).toHaveClass("liquid-refractive");
  expect(panel).toHaveAttribute("data-liquid-surface");
  expect(panel.style.getPropertyValue("--liquid-filter")).toBe("");
  expect(panel).not.toHaveAttribute("data-liquid-optics");
  expect(document.querySelector(".liquid-filter-definitions filter")).toBeNull();
  mounted.unmount(); panel.remove();
});

it("keeps the selection below its labels when its optical map cannot render", () => {
  vi.mocked(lensMap).mockReturnValueOnce(null);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome/140");
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const glass = document.createElement("span"); glass.className = "liquid-selection-glass";
  Object.defineProperties(glass, { offsetWidth: { value: 212 }, offsetHeight: { value: 66 } });
  document.body.append(glass);
  const mounted = render(<LiquidGlassEffects />);
  expect(glass).toHaveAttribute("data-liquid-surface");
  expect(glass).not.toHaveAttribute("data-liquid-optics");
  expect(glass.style.getPropertyValue("--liquid-filter")).toBe("");
  mounted.unmount(); glass.remove();
});

it("does not reuse the panel's displacement map for a liquid bubble of the same size", () => {
  vi.mocked(lensMap).mockClear();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome/140");
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const host = document.createElement("div");
  for (const className of ["glass-card", "liquid-selection-glass", "liquid-selection-refraction"]) {
    const element = document.createElement("span"); element.className = className; element.style.borderRadius = "18px";
    Object.defineProperties(element, { offsetWidth: { value: 140 }, offsetHeight: { value: 36 } });
    host.append(element);
  }
  document.body.append(host);
  const mounted = render(<LiquidGlassEffects />);
  expect(lensMap).toHaveBeenCalledTimes(2);
  expect(lensMap).toHaveBeenCalledWith({ width: 140, height: 36, radius: 18 });
  expect(lensMap).toHaveBeenCalledWith({ width: 140, height: 36, radius: 18, profile: "liquid" });
  mounted.unmount(); host.remove();
});

it("removes optical filters when the user requests less transparency", async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Chrome/140");
  vi.stubGlobal("CSS", { supports: () => true });
  const transparency = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", (query: string) => query.includes("transparency") ? transparency : { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const panel = document.createElement("div"); panel.className = "glass-card";
  Object.defineProperties(panel, { offsetWidth: { value: 300 }, offsetHeight: { value: 200 } });
  document.body.append(panel);
  const mounted = render(<LiquidGlassEffects />);
  expect(panel.style.getPropertyValue("--liquid-filter")).not.toBe("");
  expect(panel).toHaveAttribute("data-liquid-optics", "true");
  await act(async () => { transparency.matches = true; transparency.addEventListener.mock.calls[0][1](); vi.advanceTimersByTime(75); });
  expect(panel.style.getPropertyValue("--liquid-filter")).toBe("");
  expect(panel).not.toHaveAttribute("data-liquid-optics");
  expect(panel).not.toHaveClass("liquid-refractive");
  expect(document.querySelector(".liquid-filter-definitions filter")).toBeNull();
  mounted.unmount(); panel.remove();
});
