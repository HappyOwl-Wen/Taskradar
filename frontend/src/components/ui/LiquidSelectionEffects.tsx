import { useEffect } from "react";
import { LIQUID_LAYOUT_EVENT } from "@/lib/liquidGlass";
import { selectionFrames, selectionRefractionFrames, selectionSymbolFrames, SELECTION_DURATION, SELECTION_LENS_INSET, type SelectionBox } from "@/lib/liquidMotion";

const SCOPE = "[data-selection-scope]";
const ACTIVE = '[aria-current="page"], [aria-current="date"], [data-state="active"], [aria-pressed="true"]';
interface Selection { lens: HTMLSpanElement; refraction: HTMLSpanElement; target: HTMLElement | null; box: SelectionBox | null; animation: Animation | null; optics: Animation | null; symbol: Animation | null }

/** A persistent material below the labels, with synchronized transient refraction above them. */
export function LiquidSelectionEffects() {
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || typeof matchMedia !== "function") return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const groups = new Map<HTMLElement, Selection>();
    let frame = 0, disposed = false;
    let pressed: Selection | null = null;
    const release = () => { if (pressed) { delete pressed.lens.dataset.pressed; pressed = null; } };
    const boxIn = (element: HTMLElement, group: HTMLElement): SelectionBox => {
      const rect = element.getBoundingClientRect(), parent = group.getBoundingClientRect();
      const sx = parent.width / group.offsetWidth || 1, sy = parent.height / group.offsetHeight || 1;
      return { x: (rect.left - parent.left) / sx + group.scrollLeft - group.clientLeft, y: (rect.top - parent.top) / sy + group.scrollTop - group.clientTop, width: rect.width / sx, height: rect.height / sy };
    };
    const remove = (group: HTMLElement, selection: Selection) => {
      if (pressed === selection) release();
      selection.animation?.cancel(); selection.animation = null;
      selection.optics?.cancel(); selection.optics = null;
      selection.symbol?.cancel(); selection.symbol = null;
      resize.unobserve(group);
      if (selection.target) resize.unobserve(selection.target);
      selection.lens.remove();
      selection.refraction.remove();
      group.removeAttribute("data-selection-ready");
      groups.delete(group);
    };
    const update = () => {
      frame = 0;
      if (disposed) return;
      const changedLenses: HTMLElement[] = [];
      for (const [group, selection] of groups) if (!group.isConnected || !group.matches(SCOPE)) remove(group, selection);
      for (const group of document.querySelectorAll<HTMLElement>(SCOPE)) {
        const target = Array.from(group.querySelectorAll<HTMLElement>(ACTIVE)).find((element) => element.closest(SCOPE) === group);
        let selection = groups.get(group);
        if (!target || target.getBoundingClientRect().width === 0 || getComputedStyle(group).visibility === "hidden") {
          if (selection) {
            if (pressed === selection) release();
            selection.animation?.cancel(); selection.animation = null;
            selection.optics?.cancel(); selection.optics = null;
            selection.symbol?.cancel(); selection.symbol = null;
            selection.lens.hidden = true; selection.box = null; selection.lens.dataset.motion = "idle";
            selection.lens.style.removeProperty("will-change"); group.removeAttribute("data-selection-ready");
            selection.refraction.style.removeProperty("will-change");
          }
          continue;
        }
        if (!selection) {
          const lens = document.createElement("span"), refraction = document.createElement("span");
          lens.className = "liquid-selection";
          refraction.className = "liquid-selection-refraction";
          for (const layer of [lens, refraction]) { layer.setAttribute("aria-hidden", "true"); layer.style.position = "absolute"; }
          lens.style.setProperty("--selection-inset-x", `${SELECTION_LENS_INSET.x}px`);
          lens.style.setProperty("--selection-inset-y", `${SELECTION_LENS_INSET.y}px`);
          const glass = document.createElement("span"), rim = document.createElement("span");
          glass.className = "liquid-selection-glass"; rim.className = "liquid-selection-rim";
          glass.append(rim); lens.append(glass);
          group.append(lens, refraction);
          selection = { lens, refraction, target: null, box: null, animation: null, optics: null, symbol: null };
          groups.set(group, selection);
          resize.observe(group);
        }
        const next = boxIn(target, group);
        const previous = selection.box;
        const changed = selection.target !== target;
        if (!changed && previous && ["x", "y", "width", "height"].every((key) => Math.abs(previous[key as keyof SelectionBox] - next[key as keyof SelectionBox]) < .5)) continue;
        const from = previous ? boxIn(selection.lens, group) : next;
        const visibleRefraction = selection.optics ? parseFloat(getComputedStyle(selection.refraction).opacity) || 0 : 0;
        selection.animation?.cancel();
        selection.optics?.cancel(); selection.optics = null;
        selection.refraction.style.removeProperty("will-change");
        selection.symbol?.cancel(); selection.symbol = null;
        if (selection.target !== target) {
          if (selection.target) resize.unobserve(selection.target);
          resize.observe(target);
        }
        selection.target = target;
        selection.box = next;
        selection.lens.hidden = false;
        Object.assign(selection.lens.style, { width: `${next.width}px`, height: `${next.height}px`, borderRadius: "999px", transform: `translate3d(${next.x}px, ${next.y}px, 0)` });
        Object.assign(selection.refraction.style, { width: `${next.width + SELECTION_LENS_INSET.x * 2}px`, height: `${next.height + SELECTION_LENS_INSET.y * 2}px`, borderRadius: "999px", transform: `translate3d(${next.x - SELECTION_LENS_INSET.x}px, ${next.y - SELECTION_LENS_INSET.y}px, 0)` });
        group.setAttribute("data-selection-ready", "true");
        changedLenses.push(selection.lens.querySelector<HTMLElement>(".liquid-selection-glass")!, selection.refraction);
        if (previous && !reduced.matches && typeof selection.lens.animate === "function") {
          const frames = selectionFrames(from, next, changed);
          const animation = selection.lens.animate(frames, { duration: SELECTION_DURATION, easing: "linear" });
          const start = document.timeline?.currentTime;
          if (typeof start === "number") animation.startTime = start;
          if (changed && typeof selection.refraction.animate === "function") {
            selection.optics = selection.refraction.animate(selectionRefractionFrames(frames, visibleRefraction), { duration: SELECTION_DURATION, easing: "linear" });
            if (typeof start === "number") selection.optics.startTime = start;
            void selection.optics.finished.catch(() => { /* Expected when the glide is interrupted. */ });
            selection.refraction.style.willChange = "transform, opacity";
          }
          selection.animation = animation;
          selection.lens.dataset.motion = changed ? "moving" : "resizing";
          selection.lens.style.willChange = "transform";
          const settle = () => {
            if (selection?.animation === animation) {
              selection.animation = null; selection.lens.dataset.motion = "idle"; selection.lens.style.removeProperty("will-change");
              selection.optics?.cancel(); selection.optics = null; selection.refraction.style.removeProperty("will-change");
            }
          };
          // A replacement owns the new phase; completion or cancellation of the current glide restores clear text.
          void animation.finished.then(settle, settle);
          const icon = changed ? target.querySelector<SVGElement>(".sidebar-icon > svg, :scope > svg") : null;
          if (icon && typeof icon.animate === "function") {
            const symbol = icon.animate(selectionSymbolFrames, { duration: SELECTION_DURATION, easing: "ease-in-out" });
            selection.symbol = symbol;
            void symbol.finished.then(() => { if (selection?.symbol === symbol) selection.symbol = null; }).catch(() => {});
          }
        } else {
          selection.animation = null;
          selection.lens.dataset.motion = "idle";
          selection.lens.style.removeProperty("will-change");
        }
      }
      // Resize the optical map before the first moving frame; animation never removes the refraction filter.
      if (changedLenses.length) document.dispatchEvent(new CustomEvent(LIQUID_LAYOUT_EVENT, { detail: changedLenses }));
    };
    const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    const observer = new MutationObserver((records) => {
      if (records.some(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest(".liquid-filter-definitions")) return false;
        if (record.type === "attributes" || target?.closest(SCOPE)) return true;
        return [...record.addedNodes, ...record.removedNodes].some(node =>
          node instanceof Element && (node.matches(SCOPE) || node.querySelector(SCOPE)));
      })) schedule();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-current", "aria-selected", "aria-pressed", "data-state", "class"] });
    const stopMotion = () => {
      if (reduced.matches) release();
      if (reduced.matches) for (const selection of groups.values()) {
        selection.animation?.cancel(); selection.animation = null; selection.optics?.cancel(); selection.optics = null;
        selection.symbol?.cancel(); selection.symbol = null; selection.lens.dataset.motion = "idle";
        selection.lens.style.removeProperty("will-change"); selection.refraction.style.removeProperty("will-change");
      }
      schedule();
    };
    const press = (event: PointerEvent) => {
      if (reduced.matches || event.button !== 0 || !(event.target instanceof Element)) return;
      const group = event.target.closest<HTMLElement>(SCOPE), selection = group ? groups.get(group) : null;
      if (!selection?.target?.contains(event.target)) return;
      release(); pressed = selection; selection.lens.dataset.pressed = "true";
    };
    document.addEventListener("pointerdown", press, { passive: true });
    document.addEventListener("pointerup", release, { passive: true });
    document.addEventListener("pointercancel", release, { passive: true });
    window.addEventListener("blur", release);
    reduced.addEventListener("change", stopMotion);
    window.addEventListener("resize", schedule, { passive: true });
    document.fonts?.ready.then(schedule);
    update();
    return () => {
      disposed = true; observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame);
      release();
      document.removeEventListener("pointerdown", press); document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release); window.removeEventListener("blur", release);
      reduced.removeEventListener("change", stopMotion); window.removeEventListener("resize", schedule);
      for (const [group, selection] of groups) remove(group, selection);
    };
  }, []);
  return null;
}
