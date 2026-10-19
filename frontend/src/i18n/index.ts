import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en";
import zhCN from "./zh-CN";

export type Language = "zh-CN" | "en";
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en", label: "English" },
];

const STORAGE_KEY = "taskradar.language";

export function storedLanguage(): Language {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "en" || value === "zh-CN") return value;
  } catch {
    /* storage unavailable */
  }
  return "zh-CN";
}

export function rememberLanguage(lang: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = lang;
}

void i18n.use(initReactI18next).init({
  resources: { "zh-CN": { translation: zhCN }, en: { translation: en } },
  lng: storedLanguage(),
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});
document.documentElement.lang = i18n.language;

/** Translate a key that is only known at runtime (e.g. an error code from the backend). */
export function translateKey(key: string, fallback: string, options?: Record<string, unknown>): string {
  return i18n.exists(key) ? (i18n.t as unknown as (k: string, o?: Record<string, unknown>) => string)(key, options) : fallback;
}

export default i18n;
