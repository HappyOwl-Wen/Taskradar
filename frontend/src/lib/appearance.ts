import { useSyncExternalStore } from "react";
import { imageStorage } from "./appearanceImages";
import { extractImageColor, readableAccent } from "./imagePalette";

export const APPEARANCE_KEY = "taskradar.appearance";
export const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;
export const DEFAULT_APPEARANCE = { background: "landscape", image: "", color: "#7050ad", transparency: 42, blur: 0, autoColor: true, highContrast: true, imageAccent: "" } as const;
export interface Appearance { background: "landscape" | "solid" | "image"; image: string; color: string; transparency: number; blur: number; autoColor: boolean; highContrast: boolean; imageAccent: string }
export function normalizeAppearance(value: Partial<Appearance>): Appearance {
  const number = (v: unknown, fallback: number, max: number) => typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : fallback;
  return {
    background: value.background === "solid" || value.background === "image" ? value.background : "landscape",
    image: typeof value.image === "string" && value.image.length <= Math.ceil(MAX_BACKGROUND_BYTES / 3) * 4 + 32 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value.image) ? value.image : "",
    color: typeof value.color === "string" && /^#[a-f\d]{6}$/i.test(value.color) ? value.color : DEFAULT_APPEARANCE.color,
    transparency: number(value.transparency, 42, 100), blur: number(value.blur, 0, 30),
    autoColor: value.autoColor !== false, highContrast: value.highContrast !== false,
    imageAccent: typeof value.imageAccent === "string" && /^#[a-f\d]{6}$/i.test(value.imageAccent) ? value.imageAccent : "",
  };
}
let imageKey = "";
function read(): Appearance {
  imageKey = "";
  try {
    const stored = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || "{}") ?? {};
    imageKey = typeof stored.imageKey === "string" ? stored.imageKey : "";
    return normalizeAppearance(stored);
  }
  catch { return { ...DEFAULT_APPEARANCE }; }
}
let current = read();
const listeners = new Set<() => void>();
let renderedImage = "";
let backgroundUrl = "";
export function applyAppearance(): void {
  const root = document.documentElement;
  // CSS custom properties have a browser size limit. Keep the data in a Blob,
  // not a multi-megabyte base64 token that the CSS parser silently rejects.
  if (renderedImage !== current.image) {
    const previousUrl = backgroundUrl;
    backgroundUrl = "";
    if (current.image) {
      const comma = current.image.indexOf(",");
      const type = current.image.slice(5, current.image.indexOf(";"));
      const bytes = Uint8Array.from(atob(current.image.slice(comma + 1)), (character) => character.charCodeAt(0));
      backgroundUrl = URL.createObjectURL(new Blob([bytes], { type }));
    }
    renderedImage = current.image;
    root.style.setProperty("--appearance-image", backgroundUrl ? `url("${backgroundUrl}")` : "none");
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  }
  root.dataset.background = current.background === "image" && !current.image ? "landscape" : current.background;
  root.dataset.customColor = String(current.color !== DEFAULT_APPEARANCE.color);
  root.dataset.imageContrast = String(current.highContrast && root.dataset.background === "image");
  root.style.setProperty("--readable-accent-light", readableAccent(current.color, false));
  root.style.setProperty("--readable-accent-dark", readableAccent(current.color, true));
  if (!backgroundUrl) root.style.setProperty("--appearance-image", "none");
  root.style.setProperty("--appearance-color", current.color);
  root.style.setProperty("--appearance-opacity", String(1 - current.transparency / 100));
  root.style.setProperty("--appearance-blur", `${current.blur}px`);
  window.dispatchEvent(new Event("taskradar:liquid-layout"));
}
export function setAppearance(changes: Partial<Appearance>, storedImageKey?: string): void {
  const next = normalizeAppearance({ ...current, ...changes });
  if (changes.color !== undefined && changes.autoColor === undefined) next.autoColor = false;
  if (next.autoColor && next.imageAccent) next.color = next.imageAccent;
  const nextKey = storedImageKey ?? (changes.image !== undefined ? "" : imageKey);
  // Commit only after storage succeeds, so the UI never claims an unsaved image was saved.
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ ...next, image: nextKey ? "" : next.image, imageKey: nextKey }));
  const oldKey = imageKey;
  imageKey = nextKey;
  current = next;
  applyAppearance();
  listeners.forEach((listener) => listener());
  if (oldKey && oldKey !== nextKey) void imageStorage("delete", oldKey).catch(() => undefined);
}
export async function setBackgroundImage(image: string): Promise<void> {
  if (!normalizeAppearance({ image }).image) throw new Error("Invalid background image");
  const imageAccent = await extractImageColor(image);
  const key = crypto.randomUUID();
  await imageStorage("put", key, image);
  try { setAppearance({ image, background: "image", imageAccent }, key); }
  catch (error) { void imageStorage("delete", key).catch(() => undefined); throw error; }
}
async function restoreImage(): Promise<void> {
  const key = imageKey;
  if (!key) return;
  try {
    const image = await imageStorage("get", key);
    if (imageKey !== key) return;
    current = normalizeAppearance({ ...current, image: image ?? "" });
    applyAppearance(); listeners.forEach((listener) => listener());
    // Existing backgrounds from before automatic matching get a palette once.
    if (current.image && current.autoColor && !current.imageAccent) {
      const imageAccent = await extractImageColor(current.image);
      if (imageKey === key && current.autoColor && !current.imageAccent) setAppearance({ imageAccent });
    }
  } catch { /* The default background remains available when IndexedDB is unavailable. */ }
}
export function useAppearance(): Appearance {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => current, () => current);
}
applyAppearance();
void restoreImage();
window.addEventListener("storage", (event) => {
  if (event.key === APPEARANCE_KEY || event.key === null) {
    current = read(); applyAppearance(); listeners.forEach((listener) => listener());
    void restoreImage();
  }
});
