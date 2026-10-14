import { CalendarClock, CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tip } from "@/components/ui/menu";
import { formatDue } from "@/lib/format";
import { cn } from "@/lib/utils";
import { URGENCY_TEXT } from "./meta";
import { useRelativeDueText, type DueTask } from "./useRelativeDueText";

/**
 * Compact deadline display: absolute date (never an invented time for date-only deadlines),
 * relative remaining time coloured by urgency, and a marker when the date needs confirmation.
 */
export function DueLabel({ task, className, showRelative = true }: { task: DueTask; className?: string; showRelative?: boolean }) {
  const { t, i18n } = useTranslation();
  const relative = useRelativeDueText(task);
  const year = new Date().getFullYear();
  const absolute = formatDue(task, i18n.language, year);
  if (!absolute) {
    return <span className={cn("text-xs text-muted-foreground", className)}>{t("due.none")}</span>;
  }
  const closed = task.status === "completed" || task.status === "dismissed";
  const tone = closed ? "text-muted-foreground" : URGENCY_TEXT[task.urgency];
  const tooltip = [
    task.due_text ? `${t("due.original")}: “${task.due_text}”` : null,
    task.due_time ? t(`semantics.${task.time_semantics}`) : t("due.dateOnly"),
    task.due_needs_confirmation ? t("due.needsConfirmation") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tip content={tooltip}>
      <span className={cn("inline-flex flex-col items-end text-right leading-tight", className)}>
        <span className="inline-flex items-center gap-1 text-[13px] font-medium whitespace-nowrap">
          {task.due_needs_confirmation ? (
            <CircleHelp className="size-3.5 text-high" aria-label={t("due.needsConfirmation")} />
          ) : (
            <CalendarClock className="size-3.5 text-muted-foreground" aria-hidden />
          )}
          {absolute}
        </span>
        {showRelative && relative && !closed ? (
          <span className={cn("text-xs whitespace-nowrap", tone)}>{relative}</span>
        ) : null}
      </span>
    </Tip>
  );
}
