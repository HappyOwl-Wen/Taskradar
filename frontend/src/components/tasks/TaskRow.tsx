import { CalendarCheck, CalendarClock, CalendarX, Lightbulb } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/form";
import { Tip } from "@/components/ui/menu";
import { taskIssues } from "@/lib/review";
import type { TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CategoryBadge, KeyStates, SourceKinds } from "./badges";
import { issueStates, sampleState, unconfirmedState, type KeyState } from "./keyStates";
import { DeadlineIndicator } from "./DueLabel";

function SuggestionHint({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <Tip content={t("taskItem.suggestionsHint", { count })}>
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Lightbulb className="size-3.5" aria-hidden />
        <span className="tabular-nums">{count}</span>
        <span className="sr-only">{t("taskItem.suggestionsHint", { count })}</span>
      </span>
    </Tip>
  );
}

/** Whether the task is in Google Calendar (only shown when it is, or when the event needs attention). */
function CalendarHint({ status }: { status: string | null }) {
  const { t } = useTranslation();
  if (status !== "synced" && status !== "out_of_sync" && status !== "failed") return null;
  const Icon = status === "synced" ? CalendarCheck : status === "out_of_sync" ? CalendarClock : CalendarX;
  const tone = status === "synced" ? "text-muted-foreground" : status === "out_of_sync" ? "text-urgent" : "text-destructive";
  const label = t(`taskItem.calendar.${status}`);
  return (
    <Tip content={label}>
      <span className={cn("inline-flex", tone)}>
        <Icon className="size-3.5" aria-hidden />
        <span className="sr-only">{label}</span>
      </span>
    </Tip>
  );
}

/** A conflict marker already says what a duplicate or date-conflict issue would say. */
const COVERED_BY: Record<string, string[]> = {
  conflict: ["issue:date_conflict", "issue:duplicate"],
  date_changed: ["issue:date_changed"],
};

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
  /** States that come from the context (e.g. "deadline conflict" on the dashboard); shown first. */
  states?: KeyState[];
  /** Mark unconfirmed tasks as such (lists that mix confirmed and unconfirmed tasks). */
  showUnconfirmed?: boolean;
  /** Controls at the end of the row. */
  actions?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  /** DOM id of the row's link/button (lets a list move the keyboard focus between rows). */
  controlId?: string;
  /** Leave out the issues (when the context already names the problem). */
  hideIssues?: boolean;
  /** Leave out the "test data" state (when the list groups test data under its own heading). */
  hideSample?: boolean;
  className?: string;
}

/**
 * One task in a list. The title comes first; right after it at most two key states (unconfirmed, the most
 * important problem, test data) in colour, then quiet details (category, sources, suggestions, calendar);
 * the deadline sits in its own column. The whole row is a single link or button (other controls sit above
 * it), so it is easy to hit and to reach with the keyboard. Long evidence never appears here.
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
  states = [],
  showUnconfirmed = false,
  actions,
  onKeyDown,
  controlId,
  hideIssues = false,
  hideSample = false,
  className,
}: TaskListItemProps) {
  const { t } = useTranslation();
  const closed = task.status === "completed" || task.status === "dismissed";
  const covered = new Set(states.flatMap((s) => COVERED_BY[s.key] ?? []));
  const keyStates: KeyState[] = [
    ...states,
    ...(showUnconfirmed && task.status === "candidate" && !states.some((s) => s.key === "unconfirmed") ? [unconfirmedState(t)] : []),
    ...(task.sample && !hideSample ? [sampleState(t)] : []),
    ...(closed || hideIssues ? [] : issueStates(taskIssues(task), t).filter((s) => !covered.has(s.key))),
  ];
  const stretched =
    "text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40";
  const titleClass = cn(
    "text-sm leading-snug",
    variant === "row" ? "block truncate" : "line-clamp-2 break-words",
    closed ? "text-muted-foreground line-through decoration-1" : "font-medium text-foreground",
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
  const quiet = (
    <>
      <SuggestionHint count={closed ? 0 : task.pending_suggestions} />
      {!closed ? <CalendarHint status={task.calendar_status} /> : null}
      <CategoryBadge category={task.category} iconOnly={variant === "row"} />
      <SourceKinds kinds={task.source_kinds} count={task.source_count} />
    </>
  );

  if (variant === "row") {
    return (
      <div
        className={cn(
          "group relative flex min-h-11 items-center gap-3 px-3 py-2 transition-colors hover:bg-accent",
          (active || selected) && "bg-selected/70 hover:bg-selected",
          className,
        )}
      >
        {checkbox}
        {leading ? <div className="relative z-10 flex shrink-0 items-center">{leading}</div> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2.5">
          <div className="flex min-w-0">{main}</div>
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
            <KeyStates states={keyStates} />
            {quiet}
          </div>
        </div>
        <DeadlineIndicator task={task} layout="stack" className="w-28 shrink-0 sm:w-32" />
        {actions ? <div className="relative z-10 flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent",
        active && "bg-selected shadow-[inset_3px_0_0_var(--primary)] hover:bg-selected",
        selected && !active && "bg-selected/60",
        className,
      )}
    >
      {checkbox}
      {leading ? <div className="relative z-10 shrink-0">{leading}</div> : null}
      <div className="grid min-w-0 flex-1 gap-1">
        {main}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <KeyStates states={keyStates} />
          {quiet}
        </div>
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
