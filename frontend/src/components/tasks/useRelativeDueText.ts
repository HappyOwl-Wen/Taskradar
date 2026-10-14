import { useTranslation } from "react-i18next";
import { relativeDue } from "@/lib/format";
import type { TaskSummary } from "@/lib/types";

export type DueTask = Pick<
  TaskSummary,
  "due_date" | "due_time" | "due_text" | "due_needs_confirmation" | "remaining_seconds" | "timezone" | "urgency" | "status" | "time_semantics"
>;

/** Relative phrase such as "3 days left" / "2 days overdue" / "due today". */
export function useRelativeDueText(task: DueTask): string | null {
  const { t, i18n } = useTranslation();
  const rel = relativeDue(task, i18n.language);
  switch (rel.kind) {
    case "overdue":
      return t("due.overdueBy", { value: rel.value });
    case "today":
      return t("due.dueToday");
    case "remaining":
      return t("due.remaining", { value: rel.value });
    default:
      return null;
  }
}
