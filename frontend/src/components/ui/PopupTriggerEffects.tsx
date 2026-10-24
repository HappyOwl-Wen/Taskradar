import { useEffect } from "react";
import { LIQUID_LAYOUT_EVENT } from "@/lib/liquidGlass";

const TRIGGERS = "[data-popup-trigger]";
const SIDES = ["top", "right", "bottom", "left"];
const VARIABLES = ["--trigger-x", "--trigger-y", "--trigger-compress-x", "--trigger-compress-y", "--trigger-stretch-x", "--trigger-stretch-y", "--trigger-fill", "--trigger-border", "--trigger-shadow", "--trigger-inset", "--trigger-rest-opacity"];
interface Appearance { fill: string; border: string; shadow: string; inset: string }
interface Trigger { glass: HTMLSpanElement; open: boolean; side: string; geometry: string; appearance: Appearance }

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
      button.removeAttribute("data-trigger-ready");
      for (const variable of VARIABLES) button.style.removeProperty(variable);
      triggers.delete(button);
    };
    const update = () => {
      frame = 0;
      if (disposed) return;
      let newLens = false;
      for (const [button, trigger] of triggers) if (!button.isConnected || !button.matches(TRIGGERS)) remove(button, trigger);
      const measured = Array.from(document.querySelectorAll<HTMLElement>(TRIGGERS), button => {
        const style = triggers.has(button) ? null : getComputedStyle(button);
        return { button, width: Math.max(button.offsetWidth, 1), height: Math.max(button.offsetHeight, 1), appearance: style ? {
          fill: style.backgroundColor, border: style.borderTopColor, shadow: style.boxShadow,
          inset: `${-parseFloat(style.borderTopWidth || "0")}px`,
        } : null };
      });
      for (const { button, width, height, appearance } of measured) {
        let trigger = triggers.get(button);
        if (!trigger) {
          const glass = document.createElement("span");
          glass.className = "popup-trigger-glass";
          glass.setAttribute("aria-hidden", "true");
          trigger = { glass, open: false, side: "bottom", geometry: "", appearance: appearance! };
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
        const kind = button.dataset.slot === "select-trigger" ? "field" : button.dataset.variant ?? "custom";
        const geometry = `${width}/${height}/${side}/${kind}`;
        if (trigger.geometry !== geometry) {
          const vertical = side === "top" || side === "bottom";
          button.style.setProperty("--trigger-x", `${side === "left" ? -4 : side === "right" ? 4 : 0}px`);
          button.style.setProperty("--trigger-y", `${side === "top" ? -4 : side === "bottom" ? 4 : 0}px`);
          button.style.setProperty("--trigger-compress-x", String(1 - Math.min(.08, 3 / width)));
          button.style.setProperty("--trigger-compress-y", String(1 - Math.min(.08, 3 / height)));
          button.style.setProperty("--trigger-stretch-x", String(vertical ? 1 - Math.min(.04, 2 / width) : 1 + Math.min(.08, 3 / width)));
          button.style.setProperty("--trigger-stretch-y", String(vertical ? 1 + Math.min(.08, 3 / height) : 1 - Math.min(.04, 2 / height)));
          const fill = kind === "field" ? "color-mix(in srgb, var(--card) 26%, transparent)" : kind === "outline" || kind === "glass" ? "var(--glass-raised)" : kind === "secondary" ? "var(--secondary)" : kind === "default" ? "var(--primary)" : kind === "ghost" ? "var(--glass-raised)" : trigger.appearance.fill;
          const border = kind === "field" ? "var(--glass-control-stroke)" : kind === "outline" ? "var(--border)" : kind === "ghost" ? "var(--glass-stroke)" : trigger.appearance.border;
          button.style.setProperty("--trigger-fill", fill);
          button.style.setProperty("--trigger-border", border);
          button.style.setProperty("--trigger-shadow", kind === "field" ? "none" : kind === "outline" ? "inset 0 1px 0 var(--glass-highlight)" : trigger.appearance.shadow);
          button.style.setProperty("--trigger-inset", trigger.appearance.inset);
          button.style.setProperty("--trigger-rest-opacity", kind === "ghost" ? "0" : "1");
          button.dataset.triggerReady = "true";
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
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded", "aria-controls", "data-side", "disabled", "aria-disabled", "data-variant"] });
    update();
    return () => {
      disposed = true;
      observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame);
      for (const [button, trigger] of triggers) remove(button, trigger);
    };
  }, []);
  return null;
}
