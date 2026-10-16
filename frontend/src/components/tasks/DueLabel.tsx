import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tip } from "@/components/ui/menu";
import { formatDue } from "@/lib/format";
import { cn } from "@/lib/utils";
import { URGENCY_TEXT } from "./meta";
import { useRelativeDueText, type DueTask } from "./useRelativeDueText";

/**
 * Deadline as shown in lists: the absolute date (a date-only deadline never gets an invented time),
 * the remaining time coloured by urgency, and a marker when the date still needs checking.
 * "No deadline" stays quiet: it is information, not a problem.
 */
export function DeadlineIndicator({
  task,
  className,
  showRelative = true,
  layout = "stack",
}: {
  task: DueTask;
  className?: string;
  showRelative?: boolean;
  /** "stack": date above the remaining time (right-aligned column); "inline": one line. */
  layout?: "stack" | "inline";
}) {
  const { t, i18n } = useTranslation();
  const relative = useRelativeDueText(task);
  const year = new Date().getFullYear();
  const absolute = formatDue(task, i18n.language, year);
  if (!absolute) {
    return <span className={cn("text-xs whitespace-nowrap text-muted-foreground/80", className)}>{t("due.none")}</span>;
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
  const rel = showRelative && relative && !closed ? <span className={cn("whitespace-nowrap", tone)}>{relative}</span> : null;
  return (
    <Tip content={tooltip}>
      <span
        className={cn(
          "inline-flex leading-tight",
          layout === "stack" ? "flex-col items-end text-right" : "flex-wrap items-center gap-x-1.5",
          className,
        )}
      >
        <span className={cn("inline-flex items-center gap-1 text-[13px] whitespace-nowrap", closed ? "text-muted-foreground" : "font-medium")}>
          {task.due_needs_confirmation && !closed ? (
            <CircleHelp className="size-3.5 text-high" aria-label={t("due.needsConfirmation")} />
          ) : null}
          {absolute}
        </span>
        {rel ? (
          layout === "stack" ? (
            <span className="text-[13px]">{rel}</span>
          ) : (
            <span className="text-[13px]">
              <span className="text-muted-foreground" aria-hidden>
                ·{" "}
              </span>
              {rel}
            </span>
          )
        ) : null}
      </span>
    </Tip>
  );
}

/** Kept for existing call sites. */
export const DueLabel = DeadlineIndicator;
