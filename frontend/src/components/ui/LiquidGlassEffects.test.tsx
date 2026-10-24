import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { lensMaterial } from "@/lib/liquidGlass";
import { LiquidGlassEffects } from "./LiquidGlassEffects";

vi.mock("@/lib/liquidGlass", async (original) => ({
  ...await original<typeof import("@/lib/liquidGlass")>(),
  lensMaterial: vi.fn(() => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    return { displacement: png, lighting: png };
  }),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

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
  menu.style.border = "1px solid transparent";
  menu.dataset.state = "open";
  Object.defineProperties(menu, { offsetWidth: { value: 224 }, offsetHeight: { value: 160 } });
  portal.append(menu);

  // Keep fake time at zero: only MutationObserver microtasks, no 75 ms optical resize timer.
  await act(async () => { document.body.append(portal); });
  expect(menu.style.getPropertyValue("--liquid-filter")).toMatch(/^url\("#liquid-/);
  expect(lensMaterial).toHaveBeenCalledWith({ width: 224, height: 160, radius: 20, border: 1 });
  expect(document.querySelector(".liquid-filter-definitions feImage")).toHaveAttribute("href", vi.mocked(lensMaterial).mock.results.at(-1)!.value!.displacement);
  expect(menu.style.getPropertyValue("--liquid-lighting")).toMatch(/^url\("data:image\/png;base64,/);
  expect(menu.style.getPropertyValue("--liquid-inner-radius")).toBe("19px");

  mounted.unmount();
  expect(menu.style.getPropertyValue("--liquid-filter")).toBe("");
  expect(menu.style.getPropertyValue("--liquid-lighting")).toBe("");
  expect(menu.style.getPropertyValue("--liquid-inner-radius")).toBe("");
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
  expect(panel.style.getPropertyValue("--liquid-lighting")).toBe("");
  expect(document.querySelectorAll(".liquid-filter-definitions filter")).toHaveLength(0);
  mounted.unmount(); panel.remove();
});
