import { useEffect, useId, useRef } from "react";
import { DISPLACEMENT_SCALE, LIQUID_LAYOUT_EVENT, lensMap } from "@/lib/liquidGlass";

const SURFACES = ".app-topbar, .app-sidebar, .glass-dialog, .nav-drawer, .glass-popover, .glass-card, .calendar-toolbar, .calendar-view-switch, .glass-outline, .glass-action, .liquid-selection, .agent-glass-body, .dashboard-date, .timer-alarm-dialog";
const SVG = "http://www.w3.org/2000/svg";
interface Surface { filter: SVGFilterElement; image: SVGFEImageElement; key: string }

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
    const maps = new Map<string, string>();
    let serial = 0, scheduled = 0, pointerFrame = 0;
    let pointer: { element: HTMLElement; x: number; y: number } | null = null;
    const node = <T extends keyof SVGElementTagNameMap>(tag: T, attrs: Record<string, string>) => {
      const element = document.createElementNS(SVG, tag);
      for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
      return element;
    };
    const remove = (element: HTMLElement, surface: Surface) => {
      resize.unobserve(element);
      element.classList.remove("liquid-refractive");
      element.style.removeProperty("--liquid-filter");
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
      for (const element of document.querySelectorAll<HTMLElement>(SURFACES)) {
        // Layout dimensions exclude dialog/hover transforms, so the lens stays aligned during motion.
        const width = element.offsetWidth, height = element.offsetHeight;
        if (width < 12 || height < 12 || width * height > 1_500_000) {
          const previous = surfaces.get(element);
          if (previous) remove(element, previous);
          continue;
        }
        const radius = Math.min(parseFloat(getComputedStyle(element).borderTopLeftRadius) || 20, width / 2, height / 2);
        const geometry = { width: Math.round(width), height: Math.round(height), radius };
        const key = `${geometry.width}/${geometry.height}/${Math.round(radius)}`;
        let surface = surfaces.get(element);
        if (surface && !element.classList.contains("liquid-refractive")) element.classList.add("liquid-refractive");
        if (surface?.key === key) continue;
        let map = maps.get(key);
        if (!map) {
          const generated = lensMap(geometry);
          if (!generated) continue;
          map = generated;
          if (maps.size >= 32) maps.delete(maps.keys().next().value!);
          maps.set(key, map);
        }
        if (!surface) {
          const filterId = `liquid-${id}-${++serial}`;
          const filter = node("filter", { id: filterId, "color-interpolation-filters": "sRGB", filterUnits: "userSpaceOnUse", x: "0", y: "0" });
          const image = node("feImage", { x: "0", y: "0", preserveAspectRatio: "none", result: "normal-map" });
          filter.append(image,
            node("feGaussianBlur", { in: "SourceGraphic", stdDeviation: ".35", result: "clear-backdrop" }),
            node("feDisplacementMap", { in: "clear-backdrop", in2: "normal-map", scale: String(DISPLACEMENT_SCALE), xChannelSelector: "R", yChannelSelector: "G", result: "refracted" }),
            node("feColorMatrix", { in: "refracted", type: "saturate", values: "1.12" }));
          defs.append(filter);
          surface = { filter, image, key };
          surfaces.set(element, surface);
          resize.observe(element);
          element.style.setProperty("--liquid-filter", `url("#${filterId}")`);
          element.classList.add("liquid-refractive");
        }
        surface.key = key;
        surface.filter.setAttribute("width", String(geometry.width));
        surface.filter.setAttribute("height", String(geometry.height));
        surface.image.setAttribute("width", String(geometry.width));
        surface.image.setAttribute("height", String(geometry.height));
        surface.image.setAttribute("href", map);
      }
    };
    const schedule = () => { if (scheduled) window.clearTimeout(scheduled); scheduled = window.setTimeout(update, 75); };
    const resize = new ResizeObserver(schedule);
    const mutation = new MutationObserver((records) => {
      if (records.some((record) => !defs.contains(record.target))) schedule();
    });
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    const move = (event: PointerEvent) => {
      if (reduced.matches || reducedMotion.matches) return;
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>(".liquid-refractive") : null;
      if (!element) return;
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
      maps.clear();
    };
  }, [id]);
  return <svg className="liquid-filter-definitions" aria-hidden="true" focusable="false"><defs ref={definitions} /></svg>;
}
