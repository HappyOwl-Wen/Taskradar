import { Lightbulb } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/form";
import { Tip } from "@/components/ui/menu";
import { taskIssues } from "@/lib/review";
import type { TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CategoryBadge, IssueSummary, SourceKinds } from "./badges";
import { DeadlineIndicator } from "./DueLabel";

function SuggestionHint({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <Tip content={t("taskItem.suggestionsHint", { count })}>
      <span className="inline-flex items-center gap-1 text-xs text-violet">
        <Lightbulb className="size-3.5" aria-hidden />
        <span className="tabular-nums">{count}</span>
        <span className="sr-only">{t("taskItem.suggestionsHint", { count })}</span>
      </span>
    </Tip>
  );
}

interface TaskListItemProps {
  task: TaskSummary;
  /** "card": two lines with room for issues (inbox, dashboard); "row": one dense line (task list). */
  variant?: "card" | "row";
  /** Navigation target; the whole row is the link. */
  to?: string;
  /** Alternative to `to`: select the task in place (e.g. show it in the side panel). */
  onSelect?: () => void;
  /** Highlight as the task shown next to the list. */
  active?: boolean;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /** Extra control before the title (e.g. the status menu). */
  leading?: ReactNode;
  /** Short marker after the title (e.g. why the task needs attention). */
  badge?: ReactNode;
  /** Controls at the end of the row. */
  actions?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  /** DOM id of the row's link/button (lets a list move the keyboard focus between rows). */
  controlId?: string;
  /** Leave out the issue badge (when `badge` already names the problem). */
  hideIssues?: boolean;
  className?: string;
}

/**
 * One task in a list. Status, category, issues and deadline are always in the same place; the whole
 * row is a single link or button (other controls sit above it), so it is easy to hit and to reach
 * with the keyboard. Long evidence never appears here: it belongs to the detail view.
 */
export function TaskListItem({
  task,
  variant = "card",
  to,
  onSelect,
  active = false,
  selected,
  onSelectedChange,
  leading,
  badge,
  actions,
  onKeyDown,
  controlId,
  hideIssues = false,
  className,
}: TaskListItemProps) {
  const { t } = useTranslation();
  const closed = task.status === "completed" || task.status === "dismissed";
  const issues = taskIssues(task);
  const stretched =
    "text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40";
  const titleClass = cn(
    "text-sm leading-snug",
    variant === "row" ? "block truncate" : "line-clamp-2",
    closed ? "text-muted-foreground line-through decoration-1" : "font-medium",
  );
  const title = (
    <span className={titleClass} title={task.title}>
      {task.title}
    </span>
  );
  const main = onSelect ? (
    <button
      id={controlId}
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      aria-current={active ? "true" : undefined}
      className={cn(stretched, "block min-w-0 max-w-full")}
    >
      {title}
    </button>
  ) : (
    <Link id={controlId} to={to ?? `/tasks/${task.id}`} onKeyDown={onKeyDown} className={cn(stretched, "block min-w-0 max-w-full")}>
      {title}
    </Link>
  );
  const checkbox = onSelectedChange ? (
    <Checkbox
      checked={selected}
      onCheckedChange={(v) => onSelectedChange(v === true)}
      aria-label={t("taskItem.select", { title: task.title })}
      className={cn("relative z-10", variant === "card" && "mt-0.5")}
    />
  ) : null;
  const meta = (
    <>
      {badge}
      {!closed && !hideIssues ? <IssueSummary issues={issues} /> : null}
      <SuggestionHint count={closed ? 0 : task.pending_suggestions} />
      <CategoryBadge category={task.category} />
      <SourceKinds kinds={task.source_kinds} count={task.source_count} />
    </>
  );

  if (variant === "row") {
    return (
      <div
        className={cn(
          "group relative flex min-h-11 items-center gap-3 px-3 py-1.5 transition-colors hover:bg-accent/50",
          (active || selected) && "bg-accent/60",
          className,
        )}
      >
        {checkbox}
        {leading ? <div className="relative z-10 flex shrink-0 items-center">{leading}</div> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="flex min-w-0 flex-1">{main}</div>
          <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 sm:justify-end">{meta}</div>
        </div>
        <DeadlineIndicator task={task} layout="stack" className="w-28 shrink-0 sm:w-32" />
        {actions ? <div className="relative z-10 flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50",
        active && "bg-accent shadow-[inset_3px_0_0_var(--primary)]",
        selected && !active && "bg-accent/40",
        className,
      )}
    >
      {checkbox}
      {leading ? <div className="relative z-10 shrink-0">{leading}</div> : null}
      <div className="grid min-w-0 flex-1 gap-1">
        {main}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">{meta}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <DeadlineIndicator task={task} />
        {actions ? <div className="relative z-10 flex items-center gap-1">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Kept for existing call sites. */
export const TaskRow = TaskListItem;
