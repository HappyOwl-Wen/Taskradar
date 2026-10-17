import { useEffect } from "react";
import { api } from "./api";

/**
 * TaskRadar as a desktop app: the same pages, shown in TaskRadar's own window (WebView2) instead of a browser
 * tab. The server says which it is (``/api/session``). In the window,
 *  - links to other sites and the Google sign-in open in the system browser (the window shows TaskRadar only);
 *  - the page tells the window whether it holds unsaved changes, so that closing the window asks first;
 *  - the page tells the window its theme and language, for the title bar and the start screen.
 */
let desktop = false;

export function isDesktopApp(): boolean {
  return desktop;
}

export function setDesktopApp(value: boolean): void {
  desktop = value;
  if (value) {
    reported = null;
    syncUnsaved();
  }
}

// -- unsaved changes ------------------------------------------------------------------------------------------

const unsaved = new Set<symbol>();
let reported: boolean | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function syncUnsaved(): void {
  if (!desktop) return;
  clearTimeout(timer);
  // Batched: a dialog that closes as another opens is one change, not two requests.
  timer = setTimeout(() => {
    const now = unsaved.size > 0;
    if (now === reported) return;
    reported = now;
    api.updateDesktopState({ unsaved: now }).catch(() => {
      reported = null; // try again with the next change
    });
  }, 80);
}

export function hasUnsavedChanges(): boolean {
  return unsaved.size > 0;
}

/**
 * Marks unsaved input while `active` (a form with changes, a half-written to-do). Closing the window or reloading
 * the page then asks first: the desktop window with its own dialog, a browser with its "leave site?" prompt.
 */
export function useUnsavedChanges(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const token = Symbol("unsaved");
    unsaved.add(token);
    syncUnsaved();
    return () => {
      unsaved.delete(token);
      syncUnsaved();
    };
  }, [active]);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (unsaved.size > 0) event.preventDefault();
  });
}

// -- appearance -------------------------------------------------------------------------------------------------

let lastAppearance = "";

/** The theme as shown (light or dark, also when it follows Windows) and the language, for the window frame. */
export function reportAppearance(theme: "light" | "dark", language: string): void {
  if (!desktop) return;
  const key = `${theme}|${language}`;
  if (key === lastAppearance) return;
  lastAppearance = key;
  const lang = language === "en" ? "en" : "zh-CN";
  api.updateDesktopState({ theme, language: lang }).catch(() => {
    lastAppearance = "";
  });
}

/** Opens an address outside TaskRadar: in the desktop app the system browser, in a browser a new tab. */
export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
