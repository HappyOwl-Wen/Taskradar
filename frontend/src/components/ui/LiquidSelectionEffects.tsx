import { useEffect } from "react";
import { LIQUID_LAYOUT_EVENT } from "@/lib/liquidGlass";
import { selectionFrames, SELECTION_DURATION, type SelectionBox } from "@/lib/liquidMotion";

const SCOPE = "[data-selection-scope]";
const ACTIVE = '[aria-current="page"], [aria-current="date"], [data-state="active"], [aria-pressed="true"]';
interface Selection { lens: HTMLSpanElement; target: HTMLElement | null; box: SelectionBox | null; animation: Animation | null }

/** One persistent, refractive selection lens per navigation/segmented group, including portalled navigation. */
export function LiquidSelectionEffects() {
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || typeof matchMedia !== "function") return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const groups = new Map<HTMLElement, Selection>();
    let frame = 0, disposed = false;
    const boxIn = (element: HTMLElement, group: HTMLElement): SelectionBox => {
      const rect = element.getBoundingClientRect(), parent = group.getBoundingClientRect();
      const sx = parent.width / group.offsetWidth || 1, sy = parent.height / group.offsetHeight || 1;
      return { x: (rect.left - parent.left) / sx + group.scrollLeft - group.clientLeft, y: (rect.top - parent.top) / sy + group.scrollTop - group.clientTop, width: rect.width / sx, height: rect.height / sy };
    };
    const remove = (group: HTMLElement, selection: Selection) => {
      selection.animation?.cancel();
      resize.unobserve(group);
      if (selection.target) resize.unobserve(selection.target);
      selection.lens.remove();
      group.removeAttribute("data-selection-ready");
      groups.delete(group);
    };
    const update = () => {
      frame = 0;
      if (disposed) return;
      let geometryChanged = false;
      for (const [group, selection] of groups) if (!group.isConnected || !group.matches(SCOPE)) remove(group, selection);
      for (const group of document.querySelectorAll<HTMLElement>(SCOPE)) {
        const target = Array.from(group.querySelectorAll<HTMLElement>(ACTIVE)).find((element) => element.closest(SCOPE) === group);
        let selection = groups.get(group);
        if (!target || target.getBoundingClientRect().width === 0 || getComputedStyle(group).visibility === "hidden") {
          if (selection) {
            selection.animation?.cancel(); selection.animation = null;
            selection.lens.hidden = true; selection.box = null; selection.lens.dataset.motion = "idle";
            selection.lens.style.removeProperty("will-change"); group.removeAttribute("data-selection-ready");
          }
          continue;
        }
        if (!selection) {
          const lens = document.createElement("span");
          lens.className = "liquid-selection";
          lens.setAttribute("aria-hidden", "true");
          lens.style.position = "absolute";
          group.append(lens);
          selection = { lens, target: null, box: null, animation: null };
          groups.set(group, selection);
          resize.observe(group);
        }
        const next = boxIn(target, group);
        const previous = selection.box;
        const changed = selection.target !== target;
        if (!changed && previous && ["x", "y", "width", "height"].every((key) => Math.abs(previous[key as keyof SelectionBox] - next[key as keyof SelectionBox]) < .5)) continue;
        const from = previous ? boxIn(selection.lens, group) : next;
        selection.animation?.cancel();
        if (selection.target !== target) {
          if (selection.target) resize.unobserve(selection.target);
          resize.observe(target);
        }
        selection.target = target;
        selection.box = next;
        selection.lens.hidden = false;
        Object.assign(selection.lens.style, { width: `${next.width}px`, height: `${next.height}px`, borderRadius: getComputedStyle(target).borderTopLeftRadius || "14px", transform: `translate3d(${next.x}px, ${next.y}px, 0)` });
        group.setAttribute("data-selection-ready", "true");
        geometryChanged = true;
        if (changed && previous && !reduced.matches && typeof selection.lens.animate === "function") {
          const animation = selection.lens.animate(selectionFrames(from, next), { duration: SELECTION_DURATION, easing: "linear" });
          selection.animation = animation;
          selection.lens.dataset.motion = "moving";
          selection.lens.style.willChange = "transform";
          animation.finished.then(() => {
            if (selection?.animation === animation) { selection.animation = null; selection.lens.dataset.motion = "idle"; selection.lens.style.removeProperty("will-change"); }
          }).catch(() => { /* An interrupted spring restarts from its current on-screen position. */ });
        } else {
          selection.animation = null;
          selection.lens.dataset.motion = "idle";
          selection.lens.style.removeProperty("will-change");
        }
      }
      // Resize the optical map before the first moving frame; animation never removes the refraction filter.
      if (geometryChanged) document.dispatchEvent(new Event(LIQUID_LAYOUT_EVENT));
    };
    const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    const observer = new MutationObserver((records) => {
      if (records.some((record) => !(record.target instanceof Element && record.target.closest(".liquid-filter-definitions")))) schedule();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-current", "aria-selected", "aria-pressed", "data-state", "class"] });
    const stopMotion = () => {
      if (reduced.matches) for (const selection of groups.values()) { selection.animation?.cancel(); selection.animation = null; selection.lens.dataset.motion = "idle"; selection.lens.style.removeProperty("will-change"); }
      schedule();
    };
    reduced.addEventListener("change", stopMotion);
    window.addEventListener("resize", schedule, { passive: true });
    document.fonts?.ready.then(schedule);
    update();
    return () => {
      disposed = true; observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame);
      reduced.removeEventListener("change", stopMotion); window.removeEventListener("resize", schedule);
      for (const [group, selection] of groups) remove(group, selection);
    };
  }, []);
  return null;
}
