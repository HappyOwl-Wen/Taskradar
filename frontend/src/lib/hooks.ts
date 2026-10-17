import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSettings } from "./queries";

/** The user's configured time zone (default Europe/Berlin). */
export function useTimezone(): string {
  const { data } = useSettings();
  return data?.general.timezone ?? "Europe/Berlin";
}

function subscribeMedia(query: string) {
  return (callback: () => void) => {
    if (typeof window.matchMedia !== "function") return () => {};
    const media = window.matchMedia(query);
    media.addEventListener("change", callback);
    return () => media.removeEventListener("change", callback);
  };
}

/** Reactive CSS media query (false where matchMedia is unavailable, e.g. in tests). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useMemo(() => subscribeMedia(query), [query]);
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Whether an element is at least `min` pixels wide, kept up to date (window resized, navigation pane collapsed).
 * Attach the returned ref; null until measured or where ResizeObserver is missing (tests).
 */
export function useWidthAtLeast(min: number): [(element: HTMLElement | null) => void, boolean | null] {
  const [value, setValue] = useState<boolean | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback(
    (element: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!element || typeof ResizeObserver === "undefined") return;
      setValue(element.getBoundingClientRect().width >= min);
      observer.current = new ResizeObserver(([entry]) => setValue(entry.contentRect.width >= min));
      observer.current.observe(element);
    },
    [min],
  );
  return [ref, value];
}
