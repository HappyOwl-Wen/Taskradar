import type { EditorSeed } from "@/components/calendar/CalendarEditor";

export const RECOVERY_KEY = "taskradar.calendar.editor";

/** Read unfinished input without requiring the calendar editor to be mounted. */
export function loadRecovery(): EditorSeed | null {
  try { return JSON.parse(localStorage.getItem(RECOVERY_KEY) ?? "null") as EditorSeed | null; } catch { return null; }
}
