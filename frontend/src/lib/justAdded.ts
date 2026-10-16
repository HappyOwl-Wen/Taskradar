import { useSyncExternalStore } from "react";

/**
 * Tasks the user has just added, marked for a moment so the eye finds them in whichever list shows them
 * once it has refreshed.
 */
const added = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function markJustAdded(id: string, forMs = 2500) {
  added.add(id);
  notify();
  window.setTimeout(() => {
    added.delete(id);
    notify();
  }, forMs);
}

export function useJustAdded(id: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => added.has(id),
  );
}
