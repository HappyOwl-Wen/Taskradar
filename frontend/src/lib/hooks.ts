import { useMemo, useSyncExternalStore } from "react";
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
