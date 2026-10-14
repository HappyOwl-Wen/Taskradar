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

const CODE_PATTERNS: [RegExp, string, string][] = [
  [/^duplicate_content_of:(\d+)$/, "codes.duplicate_content_of", "id"],
  [/^duplicate_message_of:(\d+)$/, "codes.duplicate_message_of", "id"],
  [/^page_(\d+)_unreadable$/, "codes.page_unreadable", "page"],
  [/^page_(\d+)_ocr_failed$/, "codes.page_ocr_failed", "page"],
  [/^only_first_(\d+)_pages_processed$/, "codes.only_first_pages", "count"],
];

/** Human-readable text for backend warning / skip codes such as "page_2_ocr_failed". */
export function describeCode(code: string): string {
  for (const [pattern, key, variable] of CODE_PATTERNS) {
    const match = pattern.exec(code);
    if (match) return translateKey(key, code, { [variable]: match[1] });
  }
  return translateKey(`codes.${code}`, code);
}

/** Translate a key that is only known at runtime (e.g. an error code from the backend). */
export function translateKey(key: string, fallback: string, options?: Record<string, unknown>): string {
  return i18n.exists(key) ? (i18n.t as unknown as (k: string, o?: Record<string, unknown>) => string)(key, options) : fallback;
}

export default i18n;
