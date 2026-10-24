import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { changeGlassLayout } from "./layoutTransition";

interface Running {
  element: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>; finish: () => void; finished: Promise<void>;
}
let workspace: HTMLDivElement, material: HTMLSpanElement, wide: boolean;
const running: Running[] = [];
const rect = (left: number, width: number) => ({ left, top: 12, width, height: 900 }) as DOMRect;
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");

beforeEach(() => {
  wide = true; running.length = 0;
  workspace = document.createElement("div"); workspace.className = "app-workspace";
  const sidebar = document.createElement("aside"); sidebar.className = "app-sidebar";
  material = document.createElement("span"); material.className = "sidebar-material";
  sidebar.append(material, document.createElement("nav")); document.body.append(sidebar, workspace);
  vi.spyOn(workspace, "getBoundingClientRect").mockImplementation(() => wide ? rect(268, 920) : rect(100, 1088));
  vi.spyOn(material, "getBoundingClientRect").mockImplementation(() => rect(12, wide ? 244 : 76));
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    let finish!: () => void, reject!: () => void;
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = () => fail(new Error("cancelled")); });
    const cancel = vi.fn(reject);
    running.push({ element: this, frames: frames as Keyframe[], options: options as KeyframeAnimationOptions, cancel, finish, finished });
    return { finished, cancel } as unknown as Animation;
  } });
});
afterEach(() => {
  document.body.replaceChildren(); changeGlassLayout(() => {});
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

it("changes layout once and uses only compositor transforms and opacity, without scaling page text", async () => {
  const update = vi.fn(() => { wide = false; });
  changeGlassLayout(update);
  expect(update).toHaveBeenCalledOnce();
  expect(document.documentElement).toHaveAttribute("data-layout-transition", "active");
  expect(running[0].frames[0].transform).toBe("translate3d(168px, 0px, 0) scaleX(1)");
  expect(running[1].frames[0].transform).toContain(`scaleX(${244 / 76})`);
  for (const animation of running) {
    for (const frame of animation.frames) expect(Object.keys(frame).every(key => key === "transform" || key === "opacity")).toBe(true);
  }
  for (const animation of running) animation.finish();
  await Promise.allSettled(running.map(animation => animation.finished));
  expect(workspace.style.willChange).toBe(""); expect(material.style.willChange).toBe("");
  expect(document.documentElement).not.toHaveAttribute("data-layout-transition");
});

it("cancels an interrupted transition and cleans up the last one", async () => {
  changeGlassLayout(() => { wide = false; });
  const previous = [...running];
  changeGlassLayout(() => { wide = true; });
  expect(previous.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
  await Promise.allSettled(previous.map(animation => animation.finished));
  expect(document.documentElement).toHaveAttribute("data-layout-transition", "active");
  for (const animation of running) animation.finish();
  await Promise.allSettled(running.map(animation => animation.finished));
  expect(document.documentElement).not.toHaveAttribute("data-layout-transition");
});

it("applies the new layout directly when reduced motion is enabled", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const update = vi.fn(); changeGlassLayout(update);
  expect(update).toHaveBeenCalledOnce(); expect(running).toHaveLength(0);
  expect(document.documentElement).not.toHaveAttribute("data-layout-transition");
});

it("keeps navigation functional without the Web Animations API", () => {
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: undefined });
  const update = vi.fn(); changeGlassLayout(update);
  expect(update).toHaveBeenCalledOnce();
  expect(document.documentElement).not.toHaveAttribute("data-layout-transition");
});
