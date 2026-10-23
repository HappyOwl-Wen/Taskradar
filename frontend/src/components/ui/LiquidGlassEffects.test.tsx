import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { lensMap } from "@/lib/liquidGlass";
import { LiquidGlassEffects } from "./LiquidGlassEffects";

vi.mock("@/lib/liquidGlass", async (original) => ({
  ...await original<typeof import("@/lib/liquidGlass")>(),
  lensMap: vi.fn(() => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("prepares refraction for a portalled menu before the resize debounce can leave its first spring frames without glass", async () => {
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
  expect(lensMap).toHaveBeenCalledWith({ width: 224, height: 160, radius: 20 });
  expect(document.querySelector(".liquid-filter-definitions feImage")).toHaveAttribute("href", vi.mocked(lensMap).mock.results.at(-1)!.value);

  mounted.unmount();
  expect(menu.style.getPropertyValue("--liquid-filter")).toBe("");
  portal.remove();
});
