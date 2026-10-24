import { useEffect, useId, useRef } from "react";
import { DISPLACEMENT_SCALE, LIQUID_LAYOUT_EVENT } from "@/lib/liquidGlass";
import { createLensRenderer } from "@/lib/lensRenderer";

const SURFACES = ".app-topbar, .sidebar-material, .glass-dialog, .nav-drawer, .glass-popover, .glass-card, .calendar-toolbar, .calendar-view-switch, .glass-outline:not([data-popup-trigger]), .glass-primary:not([data-popup-trigger]), .glass-action, .liquid-selection, .popup-trigger-glass, .agent-glass-body, .dashboard-date, .timer-alarm-dialog";
const SVG = "http://www.w3.org/2000/svg";
interface Surface { filter: SVGFilterElement; image: SVGFEImageElement; key: string; area: number }

/** Refract the real backdrop, while leaving text and controls outside the optical filter. */
export function LiquidGlassEffects() {
  const definitions = useRef<SVGDefsElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  useEffect(() => {
    if (!definitions.current || typeof ResizeObserver === "undefined" || typeof CSS === "undefined") return;
    const reduced = matchMedia("(prefers-reduced-transparency: reduce), (forced-colors: active), (prefers-contrast: more)");
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    // Chromium/WebView2 implements SVG backdrop filters; other engines retain the clear CSS material.
    if (!/Chrome|Chromium|Edg\//.test(navigator.userAgent) || !CSS.supports("backdrop-filter", 'url("#lens")')) return;
    const defs = definitions.current;
    const surfaces = new Map<HTMLElement, Surface>();
    const renderer = createLensRenderer();
    let serial = 0, scheduled = 0, pointerFrame = 0;
    let pointer: { element: HTMLElement; x: number; y: number } | null = null;
    const node = <T extends keyof SVGElementTagNameMap>(tag: T, attrs: Record<string, string>) => {
      const element = document.createElementNS(SVG, tag);
      for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
      return element;
    };
    const makeFilter = (filterId: string) => {
      const filter = node("filter", { id: filterId, "color-interpolation-filters": "sRGB", filterUnits: "userSpaceOnUse", x: "0", y: "0" });
      const image = node("feImage", { x: "0", y: "0", preserveAspectRatio: "none", result: "normal-map" });
      filter.append(image, node("feDisplacementMap", { in: "SourceGraphic", in2: "normal-map", scale: String(DISPLACEMENT_SCALE), xChannelSelector: "R", yChannelSelector: "G" }));
      defs.append(filter);
      return { filter, image };
    };
    const remove = (element: HTMLElement, surface: Surface) => {
      resize.unobserve(element);
      element.classList.remove("liquid-refractive");
      element.style.removeProperty("--liquid-filter");
      element.style.removeProperty("--liquid-lighting");
      element.style.removeProperty("--liquid-inner-radius");
      element.style.removeProperty("--glass-pointer-x");
      element.style.removeProperty("--glass-pointer-y");
      surface.filter.remove();
      surfaces.delete(element);
    };
    const update = () => {
      window.clearTimeout(scheduled);
      scheduled = 0;
      for (const [element, surface] of surfaces) if (!element.isConnected || !element.matches(SURFACES) || reduced.matches) remove(element, surface);
      if (reduced.matches) return;
      // Batch reads before touching SVG/classes: never alternate layout reads and style writes per panel.
      const measured = Array.from(document.querySelectorAll<HTMLElement>(SURFACES), element => {
        const style = getComputedStyle(element);
        return { element, width: element.offsetWidth, height: element.offsetHeight,
          radius: parseFloat(style.borderTopLeftRadius) || 20, border: parseFloat(style.borderLeftWidth) || 0 };
      });
      for (const { element, width, height, radius: measuredRadius, border } of measured) {
        // Layout dimensions exclude dialog/hover transforms, so the lens stays aligned during motion.
        if (width < 12 || height < 12 || width * height > 1_500_000) {
          const previous = surfaces.get(element);
          if (previous) remove(element, previous);
          continue;
        }
        const radius = Math.min(measuredRadius, width / 2, height / 2);
        const geometry = { width: Math.round(width), height: Math.round(height), radius, border };
        const key = `${geometry.width}/${geometry.height}/${Math.round(radius)}/${border}`;
        let surface = surfaces.get(element);
        if (surface?.image.hasAttribute("href") && !element.classList.contains("liquid-refractive")) element.classList.add("liquid-refractive");
        element.style.setProperty("--liquid-inner-radius", `${Math.max(0, radius - border)}px`);
        if (surface?.key === key) continue;
        if (!surface) {
          const filterId = `liquid-${id}-${++serial}`;
          const { filter, image } = makeFilter(filterId);
          surface = { filter, image, key, area: width * height };
          surfaces.set(element, surface);
          resize.observe(element);
        }
        surface.key = key;
        surface.area = width * height;
        surface.filter.setAttribute("width", String(geometry.width));
        surface.filter.setAttribute("height", String(geometry.height));
        surface.image.setAttribute("width", String(geometry.width));
        surface.image.setAttribute("height", String(geometry.height));
        const current = surface;
        renderer.request(key, geometry, material => {
          if (!material || reduced.matches || surfaces.get(element) !== current || current.key !== key) return;
          current.image.setAttribute("href", material.displacement);
          element.style.setProperty("--liquid-filter", `url("#${current.filter.id}")`);
          element.style.setProperty("--liquid-lighting", `url("${material.lighting}")`);
          element.classList.add("liquid-refractive");
        });
      }
    };
    const schedule = () => { if (scheduled) window.clearTimeout(scheduled); scheduled = window.setTimeout(update, 75); };
    const resize = new ResizeObserver(schedule);
    const mutation = new MutationObserver((records) => {
      const relevant = records.filter(record => {
        if (defs.contains(record.target)) return false;
        if (record.type !== "attributes") return true;
        if (!(record.target instanceof HTMLElement) || !(record.target.matches(SURFACES) || surfaces.has(record.target))) return false;
        const withoutLens = (classes: string | null) => (classes ?? "").split(/\s+/).filter(name => name !== "liquid-refractive").join(" ");
        return withoutLens(record.oldValue) !== withoutLens(record.target.getAttribute("class"));
      });
      if (!relevant.length) return;
      const popupAdded = relevant.some((record) => record.type === "childList" && Array.from(record.addedNodes).some((node) =>
        node instanceof Element && (node.matches(".glass-popover") || node.querySelector(".glass-popover"))));
      // Start a new menu's map immediately; cached geometry is ready without waiting for the resize debounce.
      if (popupAdded) update();
      else schedule();
    });
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    const move = (event: PointerEvent) => {
      if (reduced.matches || reducedMotion.matches) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-popup-trigger], .liquid-refractive") : null;
      const element = target?.matches("[data-popup-trigger]") ? target.querySelector<HTMLElement>(".popup-trigger-glass") : target;
      // Moving highlights on a large backdrop repaint the entire panel at pointer frequency.
      if (!element || !surfaces.has(element) || surfaces.get(element)!.area > 16_384) return;
      pointer = { element, x: event.clientX, y: event.clientY };
      if (pointerFrame) return;
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        if (!pointer?.element.isConnected) return;
        const { left, top, width, height } = pointer.element.getBoundingClientRect();
        pointer.element.style.setProperty("--glass-pointer-x", `${(pointer.x - left) / width * 100}%`);
        pointer.element.style.setProperty("--glass-pointer-y", `${(pointer.y - top) / height * 100}%`);
      });
    };
    document.addEventListener("pointermove", move, { passive: true });
    reduced.addEventListener("change", schedule);
    window.addEventListener("resize", schedule, { passive: true });
    document.addEventListener(LIQUID_LAYOUT_EVENT, update);
    update();
    return () => {
      mutation.disconnect(); resize.disconnect();
      window.clearTimeout(scheduled); cancelAnimationFrame(pointerFrame);
      document.removeEventListener("pointermove", move);
      reduced.removeEventListener("change", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener(LIQUID_LAYOUT_EVENT, update);
      for (const [element, surface] of surfaces) remove(element, surface);
      renderer.dispose();
    };
  }, [id]);
  return <svg className="liquid-filter-definitions" aria-hidden="true" focusable="false"><defs ref={definitions} /></svg>;
}
