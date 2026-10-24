import { useEffect } from "react";
import { LIQUID_LAYOUT_EVENT } from "@/lib/liquidGlass";

const TRIGGERS = "[data-popup-trigger]";
const SIDES = ["top", "right", "bottom", "left"];
const VARIABLES = ["--trigger-x", "--trigger-y", "--trigger-compress-x", "--trigger-compress-y", "--trigger-stretch-x", "--trigger-stretch-y"];
interface Trigger { glass: HTMLSpanElement; open: boolean; side: string; geometry: string }

/** Animate a decorative lens, keeping the real button's hit area and Popper anchor completely still. */
export function PopupTriggerEffects() {
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const triggers = new Map<HTMLElement, Trigger>();
    let frame = 0, disposed = false;
    const remove = (button: HTMLElement, trigger: Trigger) => {
      resize.unobserve(button);
      trigger.glass.remove();
      button.removeAttribute("data-trigger-motion");
      button.removeAttribute("data-trigger-side");
      for (const variable of VARIABLES) button.style.removeProperty(variable);
      triggers.delete(button);
    };
    const update = () => {
      frame = 0;
      if (disposed) return;
      let newLens = false;
      for (const [button, trigger] of triggers) if (!button.isConnected || !button.matches(TRIGGERS)) remove(button, trigger);
      for (const button of document.querySelectorAll<HTMLElement>(TRIGGERS)) {
        let trigger = triggers.get(button);
        if (!trigger) {
          const glass = document.createElement("span");
          glass.className = "popup-trigger-glass";
          glass.setAttribute("aria-hidden", "true");
          trigger = { glass, open: false, side: "bottom", geometry: "" };
          triggers.set(button, trigger);
          button.dataset.triggerMotion = "idle";
          resize.observe(button);
        }
        // A translated text-only React child may replace textContent, including this decorative lens.
        if (trigger.glass.parentElement !== button) { button.append(trigger.glass); newLens = true; }
        const open = button.getAttribute("aria-expanded") === "true" && !button.matches(":disabled, [aria-disabled=true]");
        const content = open ? document.getElementById(button.getAttribute("aria-controls") ?? "") : null;
        const placedSide = content?.dataset.side;
        const side = placedSide && SIDES.includes(placedSide) ? placedSide : trigger.side;
        const width = Math.max(button.offsetWidth, 1), height = Math.max(button.offsetHeight, 1);
        const geometry = `${width}/${height}/${side}`;
        if (trigger.geometry !== geometry) {
          const vertical = side === "top" || side === "bottom";
          button.style.setProperty("--trigger-x", `${side === "left" ? -4 : side === "right" ? 4 : 0}px`);
          button.style.setProperty("--trigger-y", `${side === "top" ? -4 : side === "bottom" ? 4 : 0}px`);
          button.style.setProperty("--trigger-compress-x", String(1 - Math.min(.2, 6 / width)));
          button.style.setProperty("--trigger-compress-y", String(1 - Math.min(.2, 6 / height)));
          button.style.setProperty("--trigger-stretch-x", String(vertical ? 1 - Math.min(.12, 4 / width) : 1 + Math.min(.24, 8 / width)));
          button.style.setProperty("--trigger-stretch-y", String(vertical ? 1 + Math.min(.24, 8 / height) : 1 - Math.min(.12, 4 / height)));
          button.dataset.triggerSide = side;
          trigger.geometry = geometry;
          trigger.side = side;
        }
        if (trigger.open !== open) {
          button.dataset.triggerMotion = open ? "launch" : "return";
          trigger.open = open;
        }
      }
      if (newLens) document.dispatchEvent(new Event(LIQUID_LAYOUT_EVENT));
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    const observer = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element && record.target.closest(".liquid-filter-definitions")))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded", "aria-controls", "data-side", "disabled", "aria-disabled"] });
    update();
    return () => {
      disposed = true;
      observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame);
      for (const [button, trigger] of triggers) remove(button, trigger);
    };
  }, []);
  return null;
}
