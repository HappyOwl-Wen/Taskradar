import { useTranslation } from "react-i18next";
import { formatDate, formatDateTime } from "@/lib/format";
import type { TaskSourceEntry } from "@/lib/types";

export function sourceTitle(entry: TaskSourceEntry): string {
  return entry.message?.subject || entry.document?.name || entry.label;
}

/** When the source was written or received; date-only sources never get an invented time. */
export function useSourceWhen(timezone: string) {
  const { i18n } = useTranslation();
  return (entry: TaskSourceEntry) => {
    const date = entry.message?.sent_at ?? entry.source_date ?? entry.document?.imported_at ?? entry.created_at;
    return entry.source_day ? formatDate(entry.source_day, i18n.language) : formatDateTime(date, i18n.language, timezone);
  };
}
