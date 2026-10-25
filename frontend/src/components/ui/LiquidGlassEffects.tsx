import { useEffect, useId, useRef } from "react";
import { DISPLACEMENT_CENTER, DISPLACEMENT_SCALE, GLASS_SURFACES, LIQUID_LAYOUT_EVENT } from "@/lib/liquidGlass";
import { createLensRenderer } from "@/lib/lensRenderer";

const SURFACES = GLASS_SURFACES;
const SVG = "http://www.w3.org/2000/svg";
interface Surface { filter: SVGFilterElement | null; image: SVGFEImageElement | null; key: string; area: number; tiles: SVGElement[] }

/** Refract the real backdrop; selection overlays include the labels and icons underneath. */
export function LiquidGlassEffects() {
  const definitions = useRef<SVGDefsElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  useEffect(() => {
    if (!definitions.current || typeof ResizeObserver === "undefined" || typeof CSS === "undefined") return;
    const reduced = matchMedia("(prefers-reduced-transparency: reduce), (forced-colors: active), (prefers-contrast: more)");
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    // Chromium/WebView2 implements SVG backdrop filters; other engines retain the clear CSS material.
    const canRefract = /Chrome|Chromium|Edg\//.test(navigator.userAgent) && CSS.supports("backdrop-filter", 'url("#lens")');
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
      // An 8-bit map stores neutral at 128/255. Centre it at .5 to avoid shifting every glyph by .125px.
      const centered = node("feComponentTransfer", { in: "normal-map", result: "normal-map-centered" });
      for (const channel of ["feFuncR", "feFuncG"] as const) centered.append(node(channel, { type: "linear", slope: "1", intercept: String(.5 - DISPLACEMENT_CENTER / 255) }));
      filter.append(image, centered, node("feDisplacementMap", { in: "SourceGraphic", in2: "normal-map-centered", scale: String(DISPLACEMENT_SCALE), xChannelSelector: "R", yChannelSelector: "G" }));
      defs.append(filter);
      return { filter, image };
    };
    const remove = (element: HTMLElement, surface: Surface) => {
      resize.unobserve(element);
      element.classList.remove("liquid-refractive");
      element.removeAttribute("data-liquid-surface");
      element.removeAttribute("data-liquid-optics");
      element.style.removeProperty("--liquid-filter");
      element.style.removeProperty("--glass-pointer-x");
      element.style.removeProperty("--glass-pointer-y");
      surface.filter?.remove();
      surfaces.delete(element);
    };
    const update = (candidates?: Iterable<HTMLElement>) => {
      if (!candidates) { window.clearTimeout(scheduled); scheduled = 0; }
      for (const [element, surface] of surfaces) if (!element.isConnected || !element.matches(SURFACES) || reduced.matches) remove(element, surface);
      if (reduced.matches) return;
      // Batch reads before touching SVG/classes: never alternate layout reads and style writes per panel.
      const measured = Array.from(candidates ?? document.querySelectorAll<HTMLElement>(SURFACES), element => {
        const style = getComputedStyle(element);
        return { element, width: element.offsetWidth, height: element.offsetHeight,
          radius: parseFloat(style.borderTopLeftRadius) || 20 };
      });
      for (const { element, width, height, radius: measuredRadius } of measured) {
        // Layout dimensions exclude dialog/hover transforms, so the lens stays aligned during motion.
        if (width < 12 || height < 12) {
          const previous = surfaces.get(element);
          if (previous) remove(element, previous);
          continue;
        }
        const radius = Math.min(measuredRadius, width / 2, height / 2);
        const profile = element.matches(".liquid-selection-glass, .liquid-selection-refraction") ? "liquid" as const : undefined;
        const geometry = { width: Math.round(width), height: Math.round(height), radius, ...(profile ? { profile } : {}) };
        const key = `${geometry.width}/${geometry.height}/${Math.round(radius)}/${profile ?? "surface"}`;
        let surface = surfaces.get(element);
        if (surface && !element.classList.contains("liquid-refractive")) element.classList.add("liquid-refractive");
        if (surface?.key === key) continue;
        if (!surface) {
          const filterId = `liquid-${id}-${++serial}`;
          const { filter, image } = canRefract && width * height <= 1_500_000 ? makeFilter(filterId) : { filter: null, image: null };
          surface = { filter, image, key, area: width * height, tiles: [] };
          surfaces.set(element, surface);
          resize.observe(element);
        }
        surface.key = key;
        surface.area = width * height;
        element.setAttribute("data-liquid-surface", "");
        element.classList.add("liquid-refractive");
        if (!canRefract || surface.area > 1_500_000) {
          surface.filter?.remove(); surface.filter = null; surface.image = null;
          element.style.removeProperty("--liquid-filter");
          element.removeAttribute("data-liquid-optics");
          continue;
        }
        if (!surface.filter || !surface.image) Object.assign(surface, makeFilter(`liquid-${id}-${++serial}`));
        const filter = surface.filter!, image = surface.image!;
        filter.setAttribute("width", String(geometry.width));
        filter.setAttribute("height", String(geometry.height));
        image.setAttribute("width", String(geometry.width));
        image.setAttribute("height", String(geometry.height));
        const current = surface;
        renderer.request(key, geometry, map => {
          if (reduced.matches || surfaces.get(element) !== current || current.key !== key) return;
          if (!map) {
            element.style.removeProperty("--liquid-filter");
            element.removeAttribute("data-liquid-optics");
            return;
          }
          current.tiles.forEach(tile => tile.remove()); current.tiles = [];
          if (typeof map === "string") image.setAttribute("href", map);
          else {
            image.removeAttribute("href");
            const flood = node("feFlood", { "flood-color": `rgb(${DISPLACEMENT_CENTER}, ${DISPLACEMENT_CENTER}, 128)`, result: "flat-map" });
            const merge = node("feMerge", { result: "normal-map" });
            merge.append(node("feMergeNode", { in: "flat-map" }));
            const tiles = map.map((tile, index) => {
              const result = `map-${index}`;
              merge.append(node("feMergeNode", { in: result }));
              return node("feImage", { x: String(tile.x), y: String(tile.y), width: String(tile.width), height: String(tile.height),
                preserveAspectRatio: "none", href: tile.image, result });
            });
            current.tiles = [flood, ...tiles, merge];
            image.after(...current.tiles);
          }
          element.style.setProperty("--liquid-filter", `url("#${filter.id}")`);
          element.setAttribute("data-liquid-optics", "true");
          element.classList.add("liquid-refractive");
        });
      }
    };
    const schedule = () => { if (scheduled) window.clearTimeout(scheduled); scheduled = window.setTimeout(update, 75); };
    const resize = new ResizeObserver(schedule);
    const mutation = new MutationObserver((records) => {
      const relevant = records.filter(record => {
        if (defs.contains(record.target)) return false;
        // Clocks and label text do not introduce lenses; ResizeObserver handles their size changes.
        if (record.type !== "attributes") return [...record.addedNodes, ...record.removedNodes].some(node =>
          node instanceof Element && (node.matches(SURFACES) || node.querySelector(SURFACES)));
        if (!(record.target instanceof HTMLElement) || !(record.target.matches(SURFACES) || surfaces.has(record.target))) return false;
        const withoutLens = (classes: string | null) => (classes ?? "").split(/\s+/).filter(name => name !== "liquid-refractive").join(" ");
        return withoutLens(record.oldValue) !== withoutLens(record.target.getAttribute("class"));
      });
      if (!relevant.length) return;
      const popupAdded = relevant.some((record) => record.type === "childList" && Array.from(record.addedNodes).some((node) =>
        node instanceof Element && (node.matches(".glass-popover, .glass-dialog, .nav-drawer, .fc-popover") || node.querySelector(".glass-popover, .glass-dialog, .nav-drawer, .fc-popover"))));
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
      if (!element || !surfaces.has(element) || surfaces.get(element)!.area > 16_384) { resetPointer(); return; }
      if (pointer?.element !== element) resetPointer();
      pointer = { element, x: event.clientX, y: event.clientY };
      if (pointerFrame) return;
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        if (!pointer?.element.isConnected) return;
        const { left, top, width, height } = pointer.element.getBoundingClientRect();
        if (!width || !height) return;
        pointer.element.style.setProperty("--glass-pointer-x", `${Math.max(0, Math.min(1, (pointer.x - left) / width)) * 100}%`);
        pointer.element.style.setProperty("--glass-pointer-y", `${Math.max(0, Math.min(1, (pointer.y - top) / height)) * 100}%`);
      });
    };
    const resetPointer = () => {
      if (!pointer) return;
      pointer.element.style.removeProperty("--glass-pointer-x");
      pointer.element.style.removeProperty("--glass-pointer-y");
      pointer = null;
    };
    const stopMotion = () => { if (reducedMotion.matches) { cancelAnimationFrame(pointerFrame); pointerFrame = 0; resetPointer(); } };
    document.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", resetPointer);
    reducedMotion.addEventListener("change", stopMotion);
    reduced.addEventListener("change", schedule);
    window.addEventListener("resize", schedule, { passive: true });
    const layout = (event: Event) => {
      const elements = (event as CustomEvent<HTMLElement[] | undefined>).detail;
      update(elements?.filter(element => element.isConnected && element.matches(SURFACES)));
    };
    document.addEventListener(LIQUID_LAYOUT_EVENT, layout);
    update();
    return () => {
      mutation.disconnect(); resize.disconnect();
      window.clearTimeout(scheduled); cancelAnimationFrame(pointerFrame);
      document.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", resetPointer);
      reducedMotion.removeEventListener("change", stopMotion);
      reduced.removeEventListener("change", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener(LIQUID_LAYOUT_EVENT, layout);
      for (const [element, surface] of surfaces) remove(element, surface);
      renderer.dispose();
    };
  }, [id]);
  return <svg className="liquid-filter-definitions" aria-hidden="true" focusable="false"><defs ref={definitions} /></svg>;
}
