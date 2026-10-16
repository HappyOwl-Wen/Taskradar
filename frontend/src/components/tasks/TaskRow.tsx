import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/form";
import { useJustAdded } from "@/lib/justAdded";
import { taskIssues } from "@/lib/review";
import type { TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { KeyStates } from "./badges";
import { calendarState, issueStates, sampleState, suggestionStates, unconfirmedState, type KeyState } from "./keyStates";
import { DeadlineIndicator } from "./DueLabel";

/** A conflict marker already says what a duplicate or date-conflict issue would say. */
const COVERED_BY: Record<string, string[]> = {
  conflict: ["issue:date_conflict", "issue:duplicate", "suggestion:possible_duplicate", "suggestion:update_due"],
  date_changed: ["issue:date_changed"],
  "issue:duplicate": ["suggestion:possible_duplicate"],
};

interface TaskListItemProps {
  task: TaskSummary;
  /** "card": title with its state below (inbox, dashboard); "row": one dense line (task list). */
  variant?: "card" | "row";
  /** Navigation target; the whole row is the link. */
  to?: string;
  /** Alternative to `to`: select the task in place (e.g. show it in the side panel). */
  onSelect?: () => void;
  /** Highlight as the task shown next to the list. */
  active?: boolean;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /** Control before the title (e.g. the "complete" button). */
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
  /** The task is about to leave the list (e.g. just completed): shown faded until the list refreshes. */
  leaving?: boolean;
  /** One more line of context under the states (e.g. which other task a possible duplicate is about). */
  note?: ReactNode;
  className?: string;
}

/**
 * One task in a list: the title, the date and the one or two states that matter (unconfirmed, the most
 * important problem); further problems open from "N more". Category, sources and other details live in
 * the task itself. The whole row is a single link or button (other controls sit above it), so it is easy
 * to hit and to reach with the keyboard. In a narrow list the date moves under the title.
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
  leaving = false,
  note,
  className,
}: TaskListItemProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  // Just added by the user: marked for a moment and brought into view, so the eye finds it.
  const justAdded = useJustAdded(task.id);
  useEffect(() => {
    if (!justAdded) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    root.current?.scrollIntoView?.({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [justAdded]);
  const marked = justAdded && "motion-safe:animate-[just-added_1.6s_ease-out]";
  const closed = task.status === "completed" || task.status === "dismissed";
  const calendar = closed ? null : calendarState(task.calendar_status, t);
  const candidates: KeyState[] = [
    ...states,
    ...(showUnconfirmed && task.status === "candidate" && !states.some((s) => s.key === "unconfirmed") ? [unconfirmedState(t)] : []),
    ...(task.sample && !hideSample ? [sampleState(t)] : []),
    ...(closed || hideIssues ? [] : issueStates(taskIssues(task), t)),
    ...(hideIssues ? [] : suggestionStates(task.pending_suggestion_kinds, t)),
    ...(calendar ? [calendar] : []),
  ];
  // A state that another one already explains is left out (a duplicate issue and its suggestion are one thing).
  const covered = new Set(candidates.flatMap((s) => COVERED_BY[s.key] ?? []));
  const keyStates = candidates.filter((s) => !covered.has(s.key) || states.includes(s));
  const stretched =
    "text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40";
  const titleClass = cn(
    "text-sm leading-snug [overflow-wrap:anywhere]",
    variant === "row" ? "line-clamp-2 @[34rem]:line-clamp-1" : "line-clamp-2",
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
  // Narrow lists (phones, the review list) show the date under the title instead of in its own column.
  const inlineDate = <DeadlineIndicator task={task} layout="inline" className="@[26rem]:hidden" />;
  const columnDate = <DeadlineIndicator task={task} layout="stack" className="hidden @[26rem]:inline-flex" />;

  if (variant === "row") {
    return (
      <div
        ref={root}
        className={cn(
          "group relative @container flex min-h-12 items-center gap-3 px-3 py-2 transition-[background-color,opacity] duration-150 hover:bg-accent motion-reduce:transition-none",
          (active || selected) && "bg-selected/70 hover:bg-selected",
          leaving && "opacity-40",
          marked,
          className,
        )}
      >
        {checkbox}
        {leading ? <div className="relative z-10 flex shrink-0 items-center">{leading}</div> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1 @[34rem]:flex-row @[34rem]:items-center @[34rem]:gap-2.5">
          <div className="flex min-w-0">{main}</div>
          <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 empty:hidden">
            <KeyStates states={keyStates} />
            {inlineDate}
          </div>
        </div>
        <div className="hidden w-32 shrink-0 justify-end @[26rem]:flex">{columnDate}</div>
        {actions ? <div className="relative z-10 flex shrink-0 items-center gap-1 pointer-coarse:gap-3">{actions}</div> : null}
      </div>
    );
  }

  return (
    <div
      ref={root}
      className={cn(
        "group relative @container flex items-start gap-3 rounded-lg px-3 py-2.5 transition-[background-color,opacity] duration-150 hover:bg-accent motion-reduce:transition-none",
        active && "bg-selected shadow-[inset_3px_0_0_var(--primary)] hover:bg-selected",
        selected && !active && "bg-selected/60",
        leaving && "opacity-40",
        marked,
        className,
      )}
    >
      {checkbox}
      {leading ? <div className="relative z-10 shrink-0">{leading}</div> : null}
      <div className="grid min-w-0 flex-1 gap-1">
        {main}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 empty:hidden">
          <KeyStates states={keyStates} />
          {inlineDate}
        </div>
        {note ? <div className="text-[13px] leading-snug [overflow-wrap:anywhere] text-muted-foreground">{note}</div> : null}
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-1.5 @[26rem]:flex">
        {columnDate}
        {actions ? <div className="relative z-10 flex items-center gap-1">{actions}</div> : null}
      </div>
      {actions ? <div className="relative z-10 flex shrink-0 items-center gap-1 @[26rem]:hidden">{actions}</div> : null}
    </div>
  );
}

/** Kept for existing call sites. */
export const TaskRow = TaskListItem;
