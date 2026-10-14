import type { TaskSummary } from "./types";

export type Lang = "zh-CN" | "en";

const DAY = 86_400;

export function intlLocale(lang: string): string {
  return lang === "en" ? "en-GB" : "zh-CN";
}

/** The calendar date ("YYYY-MM-DD") of `now` in the given IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function parseIsoDate(value: string): { y: number; m: number; d: number } {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return { y, m, d };
}

/** Whole days from `from` to `to` (both "YYYY-MM-DD"); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / (DAY * 1000));
}

/**
 * Format a calendar date ("YYYY-MM-DD") without any time-zone shifting.
 * The year is only shown when it differs from `referenceYear`.
 */
export function formatDate(value: string, lang: string, referenceYear?: number, withWeekday = true): string {
  const { y, m, d } = parseIsoDate(value);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const showYear = referenceYear === undefined || referenceYear !== y;
  return new Intl.DateTimeFormat(intlLocale(lang), {
    timeZone: "UTC",
    year: showYear ? "numeric" : undefined,
    month: lang === "en" ? "short" : "long",
    day: "numeric",
    weekday: withWeekday ? "short" : undefined,
  }).format(date);
}

/** Deadline as shown to the user: a date-only deadline never gets an invented time. */
export function formatDue(
  task: Pick<TaskSummary, "due_date" | "due_time">,
  lang: string,
  referenceYear?: number,
): string | null {
  if (!task.due_date) return null;
  const date = formatDate(task.due_date, lang, referenceYear);
  return task.due_time ? `${date} ${task.due_time}` : date;
}

function unit(value: number, unitName: "day" | "hour" | "minute", lang: string): string {
  return new Intl.NumberFormat(intlLocale(lang), { style: "unit", unit: unitName, unitDisplay: "long" }).format(value);
}

/** Human duration for a number of seconds: "3 days", "5 hours", "20 minutes". */
export function formatSpan(seconds: number, lang: string): string {
  const s = Math.abs(seconds);
  if (s >= DAY) return unit(Math.round(s / DAY), "day", lang);
  if (s >= 3600) return unit(Math.round(s / 3600), "hour", lang);
  return unit(Math.max(1, Math.round(s / 60)), "minute", lang);
}

export type RelativeDue =
  | { kind: "overdue"; value: string }
  | { kind: "today" }
  | { kind: "remaining"; value: string }
  | { kind: "none" };

/**
 * Relative description of a deadline. Date-only deadlines are compared by calendar day in the
 * task's time zone; timed deadlines use the remaining seconds computed by the backend.
 */
export function relativeDue(
  task: Pick<TaskSummary, "due_date" | "due_time" | "remaining_seconds" | "timezone">,
  lang: string,
  now: Date = new Date(),
): RelativeDue {
  if (!task.due_date) return { kind: "none" };
  if (!task.due_time) {
    const diff = daysBetween(todayIn(task.timezone, now), task.due_date);
    if (diff === 0) return { kind: "today" };
    if (diff < 0) return { kind: "overdue", value: unit(-diff, "day", lang) };
    return { kind: "remaining", value: unit(diff, "day", lang) };
  }
  const remaining = task.remaining_seconds ?? 0;
  if (remaining < 0) return { kind: "overdue", value: formatSpan(remaining, lang) };
  return { kind: "remaining", value: formatSpan(remaining, lang) };
}

/** Format an ISO timestamp in the user's time zone. */
export function formatDateTime(value: string | null | undefined, lang: string, timeZone: string, now: Date = new Date()): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const sameYear = todayIn(timeZone, now).slice(0, 4) === todayIn(timeZone, date).slice(0, 4);
  return new Intl.DateTimeFormat(intlLocale(lang), {
    timeZone,
    year: sameYear ? undefined : "numeric",
    month: lang === "en" ? "short" : "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Clock time ("14:30") of an ISO timestamp in the given time zone. */
export function formatTime(value: string | null | undefined, lang: string, timeZone: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(intlLocale(lang), { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/** "3 minutes ago", "yesterday", "in 2 days". */
export function formatRelativeTime(value: string | null | undefined, lang: string, now: Date = new Date()): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(lang), { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < DAY) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * DAY) return rtf.format(Math.round(seconds / DAY), "day");
  if (abs < 365 * DAY) return rtf.format(Math.round(seconds / (30 * DAY)), "month");
  return rtf.format(Math.round(seconds / (365 * DAY)), "year");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Reminder offsets such as 1440 → "1 day". */
export function formatMinutes(minutes: number, lang: string): string {
  if (minutes > 0 && minutes % 1440 === 0) return unit(minutes / 1440, "day", lang);
  if (minutes > 0 && minutes % 60 === 0) return unit(minutes / 60, "hour", lang);
  return unit(minutes, "minute", lang);
}

export function durationBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
