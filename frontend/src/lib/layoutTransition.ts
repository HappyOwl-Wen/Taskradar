import { flushSync } from "react-dom";

let current: { finish: () => void } | null = null;

/** One layout update, then compositor transforms. Never animate width or capture the whole window. */
export function changeGlassLayout(update: () => void) {
  const workspace = document.querySelector<HTMLElement>(".app-workspace");
  const material = document.querySelector<HTMLElement>(".sidebar-material");
  if (!workspace || !material || typeof workspace.animate !== "function" || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    current?.finish(); update(); return;
  }
  const before = [workspace.getBoundingClientRect(), material.getBoundingClientRect()];
  current?.finish();
  flushSync(update);
  const after = [workspace.getBoundingClientRect(), material.getBoundingClientRect()];
  const root = document.documentElement, animations: Animation[] = [];
  root.dataset.layoutTransition = "active";
  const motion = {
    finish() {
      for (const animation of animations) animation.cancel();
      workspace.style.removeProperty("will-change"); material.style.removeProperty("will-change");
      if (current === motion) { current = null; delete root.dataset.layoutTransition; }
    },
  };
  current = motion;
  for (const [index, element] of [workspace, material].entries()) {
    const from = before[index], to = after[index];
    element.style.willChange = "transform";
    animations.push(element.animate([
      { transform: `translate3d(${from.left - to.left}px, ${from.top - to.top}px, 0) scaleX(${index === 0 ? 1 : from.width / Math.max(to.width, 1)})` },
      { transform: "translate3d(0, 0, 0) scaleX(1)" },
    ], { duration: 200, easing: "cubic-bezier(.16, 1, .3, 1)" }));
  }
  for (const content of document.querySelectorAll<HTMLElement>(".app-sidebar > :not(.sidebar-material):not(.liquid-selection)")) {
    animations.push(content.animate([{ opacity: .3 }, { opacity: 1 }], { duration: 140, easing: "ease-out" }));
  }
  void Promise.allSettled(animations.map(animation => animation.finished)).then(() => { if (current === motion) motion.finish(); });
}
