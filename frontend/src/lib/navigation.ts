import { useSyncExternalStore } from "react";

/** How the navigation pane is shown in wide windows: expanded with names beside the icons, or as a rail. */
export type NavMode = "expanded" | "rail";
const NAV_MODE_KEY = "taskradar.navigation";
let navMode: NavMode = readNavMode();
const navListeners = new Set<() => void>();

function readNavMode(): NavMode {
  try {
    return localStorage.getItem(NAV_MODE_KEY) === "rail" ? "rail" : "expanded";
  } catch {
    return "expanded";
  }
}

/** The user's choice for wide windows; narrower windows always show the rail (and phones a drawer). */
export function useNavMode(): [NavMode, (mode: NavMode) => void] {
  const mode = useSyncExternalStore(
    (listener) => {
      navListeners.add(listener);
      return () => navListeners.delete(listener);
    },
    () => navMode,
    () => navMode,
  );
  const set = (next: NavMode) => {
    navMode = next;
    try {
      localStorage.setItem(NAV_MODE_KEY, next);
    } catch {
      /* storage unavailable: the choice lasts until the window is closed */
    }
    navListeners.forEach((listener) => listener());
  };
  return [mode, set];
}

/** Which of the task views a task list address shows (`/tasks?scope=…`); a task's own page belongs to "all". */
export function taskScope(location: { pathname: string; search: string }): "all" | "mine" | "calendar" | null {
  if (!location.pathname.startsWith("/tasks")) return null;
  const scope = new URLSearchParams(location.search).get("scope");
  return scope === "mine" || scope === "calendar" ? scope : "all";
}
