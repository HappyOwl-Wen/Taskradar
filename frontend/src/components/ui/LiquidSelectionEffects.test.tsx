import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LiquidSelectionEffects } from "./LiquidSelectionEffects";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("glides the existing selection when its navigation changes size, and cancels it on cleanup", async () => {
  let resize!: () => void, width = 220;
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const group = document.createElement("nav"), active = document.createElement("a");
  group.dataset.selectionScope = "navigation"; active.setAttribute("aria-current", "page");
  active.style.borderRadius = "13px"; active.textContent = "Today"; group.append(active); document.body.append(group);
  const rect = () => ({ left: 0, top: 0, width, height: 44 }) as DOMRect;
  vi.spyOn(group, "getBoundingClientRect").mockImplementation(rect);
  vi.spyOn(active, "getBoundingClientRect").mockImplementation(rect);
  Object.defineProperties(group, { offsetWidth: { get: () => width }, offsetHeight: { value: 44 } });
  const mounted = render(<LiquidSelectionEffects />), lens = group.querySelector<HTMLElement>(".liquid-selection")!;
  vi.spyOn(lens, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 220, height: 44 } as DOMRect);
  const cancel = vi.fn(), animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel }));
  Object.defineProperty(lens, "animate", { value: animate });
  await act(async () => { width = 64; resize(); });
  expect(group.querySelectorAll(".liquid-selection")).toHaveLength(1);
  expect(animate).toHaveBeenCalledOnce();
  const [frames] = animate.mock.calls[0] as unknown as [Keyframe[]];
  expect(frames[0].transform).toContain(`scale(${220 / 64}, 1)`);
  expect(frames.at(-1)!.transform).toContain("scale(1, 1)");
  mounted.unmount(); expect(cancel).toHaveBeenCalledOnce(); expect(group.querySelector(".liquid-selection")).toBeNull();
  group.remove();
});
