import {
  Ban,
  CalendarClock,
  Check,
  ChevronRight,
  CircleCheck,
  Columns2,
  Ellipsis,
  FlaskConical,
  GitMerge,
  Lock,
  Pencil,
  RotateCcw,
  SearchX,
  Trash2,
  Undo2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tip } from "@/components/ui/menu";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateTime, formatDue, listSeparator } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { useAction, useTask } from "@/lib/queries";
import { taskIssues, type Issue } from "@/lib/review";
import type { Suggestion, TaskDetail, TaskEvent, TaskSourceEntry, TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CategoryBadge, StatusBadge } from "./badges";
import { ISSUE_TONE } from "./keyStates";
import { CalendarCard } from "./CalendarCard";
import { DuplicateCompare } from "./DuplicateCompare";
import { EvidenceList } from "./Evidence";
import { MergeDialog } from "./MergeDialog";
import { ISSUE_ICON, URGENCY_TEXT } from "./meta";
import { SourceList } from "./SourceList";
import { sourceTitle, useSourceWhen } from "./sourceMeta";
import { StatusMenu } from "./StatusMenu";
import { SuggestionCard } from "./SuggestionCard";
import { TaskEditDialog } from "./TaskEditDialog";
import { TechnicalDetails } from "./TechnicalDetails";
import { Timeline } from "./Timeline";
import { useRelativeDueText } from "./useRelativeDueText";

const OPEN_STATUSES: TaskStatus[] = ["confirmed", "in_progress", "waiting_for_reply"];

function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("grid gap-2.5", className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Collapsed block for secondary information (history, technical details). */
function Fold({ title, count, children, defaultOpen = false }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group/fold border-t pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-semibold text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open/fold:rotate-90" aria-hidden />
        {title}
        {count !== undefined ? <span className="font-normal tabular-nums">({count})</span> : null}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/** The deadline in one line: date, time, remaining time and what kind of time it is. */
function DueLine({ task }: { task: TaskDetail }) {
  const { t, i18n } = useTranslation();
  const relative = useRelativeDueText(task);
  const closed = task.status === "completed" || task.status === "dismissed";
  const locked = task.user_locked_fields.includes("due");
  if (!task.due_date) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CalendarClock className="size-4" /> {t("due.none")}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="flex items-center gap-2 text-base font-semibold">
        <CalendarClock className="size-4 text-muted-foreground" />
        {formatDate(task.due_date, i18n.language)}
        {task.due_time ? <span className="tabular-nums">{task.due_time}</span> : null}
      </p>
      {relative && !closed ? <span className={cn("text-sm font-medium", URGENCY_TEXT[task.urgency])}>{relative}</span> : null}
      <span className="text-xs text-muted-foreground">
        {task.due_time ? t(`semantics.${task.time_semantics}`) : t("due.dateOnly")}
        {task.due_is_relative ? ` · ${t("due.relative")}` : ""}
      </span>
      {locked ? (
        <Tip content={t("detail.locked")}>
          <Lock className="size-3.5 text-muted-foreground" aria-label={t("detail.locked")} />
        </Tip>
      ) : null}
    </div>
  );
}

function PrimaryActions({ task, onEdit, onDone }: { task: TaskDetail; onEdit: () => void; onDone?: () => void }) {
  const { t } = useTranslation();
  const change = useAction((status: TaskStatus) => api.setStatus(task.id, status), {
    success: (r) => t(`detail.statusDone.${r.status}`, { title: r.title }),
    undo: (r) => r.undo_event_id,
    onSuccess: onDone,
  });
  const go = (status: TaskStatus) => () => change.mutate(status);
  const busy = change.isPending;
  switch (task.status) {
    case "candidate":
      return (
        <>
          <Button size="sm" onClick={go("confirmed")} disabled={busy}>
            <Check /> {t("statusAction.confirm")}
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            <Pencil /> {t("inbox.editAndConfirm")}
          </Button>
          <Tip content={t("detail.dismissHint")}>
            <Button variant="ghost" size="sm" onClick={go("dismissed")} disabled={busy}>
              <Ban /> {t("statusAction.dismiss")}
            </Button>
          </Tip>
        </>
      );
    case "completed":
      return (
        <Button variant="outline" size="sm" onClick={go("confirmed")} disabled={busy}>
          <RotateCcw /> {t("statusAction.reopen")}
        </Button>
      );
    case "dismissed":
      return (
        <Button variant="outline" size="sm" onClick={go("candidate")} disabled={busy}>
          <RotateCcw /> {t("statusAction.restore")}
        </Button>
      );
    default:
      return (
        <>
          <Button size="sm" onClick={go("completed")} disabled={busy}>
            <CircleCheck /> {t("statusAction.complete")}
          </Button>
          <StatusMenu taskId={task.id} status={task.status} />
        </>
      );
  }
}

/** The automatic deadline change that the "date changed" flag is about (if it can still be undone). */
function deadlineChange(task: TaskDetail): TaskEvent | undefined {
  return task.events.find((e) => e.type === "fields_updated" && e.actor === "agent" && e.reason === "explicit_deadline_change" && e.revertible && !e.reverted);
}

function dueOf(side: unknown): { due_date: string | null; due_time: string | null } | null {
  if (typeof side !== "object" || side === null) return null;
  const s = side as Record<string, unknown>;
  return typeof s.due_date === "string" ? { due_date: s.due_date, due_time: typeof s.due_time === "string" ? s.due_time : null } : null;
}

/** "The deadline was changed automatically": what changed, and keep it or undo it. */
function DateChangedActions({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const change = deadlineChange(task);
  const keep = useAction(() => api.resolveReview(task.id, ["deadline_changed"]), {
    success: t("issue.keptNewDate"),
    undo: (r) => r.undo_event_id,
  });
  const undo = useAction((eventId: number) => api.undo(eventId), { success: t("issue.changeUndone") });
  const busy = keep.isPending || undo.isPending;
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="xs" onClick={() => keep.mutate(undefined)} disabled={busy}>
        <Check /> {t("issue.keepNewDate")}
      </Button>
      {change ? (
        <Button variant="ghost" size="xs" onClick={() => undo.mutate(change.id)} disabled={busy}>
          <Undo2 /> {t("issue.undoChange")}
        </Button>
      ) : null}
    </div>
  );
}

function IssueRow({ issue, task, duplicate, onEdit, onCompare }: { issue: Issue; task: TaskDetail; duplicate?: Suggestion; onEdit: () => void; onCompare: () => void }) {
  const { t, i18n } = useTranslation();
  const Icon = ISSUE_ICON[issue.kind];
  const other = duplicate ? (typeof duplicate.payload.other_title === "string" ? duplicate.payload.other_title : duplicate.related_task_title) : null;
  let text: string = t(`issue.${issue.kind}.hint`);
  let action: ReactNode = null;
  if (issue.kind === "duplicate" && duplicate) {
    const year = new Date().getFullYear();
    const theirs = duplicate.related_due_date ? formatDue({ due_date: duplicate.related_due_date, due_time: duplicate.related_due_time ?? null }, i18n.language, year) : null;
    const ours = formatDue(task, i18n.language, year);
    text =
      duplicate.deadlines_differ && theirs && ours
        ? t("issue.duplicate.withDates", { title: other ?? "—", own: ours, other: theirs })
        : t("issue.duplicate.withTitle", { title: other ?? "—" });
    action = (
      <Button variant="outline" size="xs" onClick={onCompare}>
        <Columns2 /> {t("compare.viewDiff")}
      </Button>
    );
  } else if (issue.kind === "date_changed") {
    const change = deadlineChange(task);
    const year = new Date().getFullYear();
    const before = dueOf(change?.data.before);
    const after = dueOf(change?.data.after);
    if (before && after) {
      text = t("issue.dateChangedFrom", {
        from: formatDue(before, i18n.language, year) ?? "—",
        to: formatDue(after, i18n.language, year) ?? "—",
      });
    }
    action = <DateChangedActions task={task} />;
  } else if (issue.kind === "date_unclear" || issue.kind === "date_conflict") {
    if (task.due_text) text = `${text} ${t("issue.originalWording", { text: task.due_text })}`;
    action = (
      <Button variant="outline" size="xs" onClick={onEdit}>
        <Pencil /> {t("issue.fixDate")}
      </Button>
    );
  } else if (issue.kind === "content_unclear") {
    action = (
      <Button variant="outline" size="xs" onClick={onEdit}>
        <Pencil /> {t("issue.fixTitle")}
      </Button>
    );
  }
  const tone = ISSUE_TONE[issue.kind];
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone === "destructive" ? "text-destructive" : tone === "urgent" ? "text-urgent" : "text-muted-foreground")} aria-hidden />
      <div className="grid min-w-0 flex-1 basis-60 gap-0.5">
        <p className="text-sm font-medium">{t(`issue.${issue.kind}.label`)}</p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{text}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

const comparable = (s: string) => s.replace(/[\s“”"'‘’「」.。,，:：;；!?！？]/g, "").toLowerCase();

/**
 * Why this is a task: what has to be done (only when it says more than the quote) and the sentences of the
 * first source that show it, with the source named underneath. The full sources follow in their own section.
 */
function Basis({ task, timezone }: { task: TaskDetail; timezone: string }) {
  const { t } = useTranslation();
  const when = useSourceWhen(timezone);
  const source = task.sources[0];
  const quotes = source?.evidence.filter((e) => e.kind === "action" || e.kind === "deadline").slice(0, 2) ?? [];
  // A later source may have changed the deadline ("extended to …"): its sentence belongs to the basis too,
  // otherwise the first quote would show a date the task no longer has.
  // Once the user has undone the automatic change, that sentence no longer explains the date.
  const changes = task.events.filter((e) => e.type === "fields_updated" && e.reason === "explicit_deadline_change");
  const undone = changes.length > 0 && changes.every((e) => e.reverted);
  const update = undone ? undefined : [...task.sources].reverse().find((s) => s !== source && s.relation === "deadline_update");
  const updateQuotes = update?.evidence.filter((e) => e.kind === "deadline" || e.kind === "action").slice(0, 1) ?? [];
  const action = (task.action_required || task.title).trim();
  const covered = quotes.some((q) => comparable(q.quote).includes(comparable(action)));
  const caption = (entry: TaskSourceEntry) => (
    <p className="truncate text-xs text-muted-foreground" title={sourceTitle(entry)}>
      {t("detail.from")} {sourceTitle(entry)} · {when(entry)}
    </p>
  );
  return (
    <div className="grid gap-2.5">
      {!covered || quotes.length === 0 ? <p className="text-sm leading-relaxed whitespace-pre-wrap">{action}</p> : null}
      {quotes.length ? <EvidenceList evidence={quotes} /> : null}
      {source && quotes.length ? caption(source) : null}
      {update && updateQuotes.length ? (
        <>
          <EvidenceList evidence={updateQuotes} />
          {caption(update)}
        </>
      ) : null}
    </div>
  );
}

export function TaskDetailView({
  taskId,
  embedded = false,
  onDeleted,
  onDecided,
}: {
  taskId: string;
  /** Shown next to a list (one column, smaller heading; decisions in a bar that stays in view). */
  embedded?: boolean;
  onDeleted?: () => void;
  /** Called after a status decision (the inbox moves on to the next task). */
  onDecided?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const timezone = useTimezone();
  const { data: task, error, isLoading, refetch } = useTask(taskId);
  const [editOpen, setEditOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const remove = useAction(() => api.deleteTask(taskId), {
    success: t("detail.deleted"),
    onSuccess: () => {
      setDeleteOpen(false);
      if (onDeleted) onDeleted();
      else navigate("/tasks");
    },
  });
  const markSample = useAction((sample: boolean) => api.setSample(taskId, sample), {
    success: (r) => (r.sample ? t("sample.marked") : t("sample.unmarked")),
    undo: (r) => r.undo_event_id,
    onSuccess: (r) => {
      if (r.calendar_warning === "sample_in_calendar") toast(t("sample.inCalendarWarning"));
    },
  });

  if (isLoading) return <LoadingRows rows={5} />;
  if (error instanceof ApiError && error.status === 404) {
    return <EmptyState icon={SearchX} title={t("app.notFound")} description={t("app.notFoundHint")} />;
  }
  if (error || !task) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const pending = task.suggestions.filter((s) => s.status === "pending");
  const duplicate = pending.find((s) => s.kind === "possible_duplicate");
  const otherSuggestions = pending.filter((s) => s !== duplicate);
  const issues = taskIssues(task);
  const Heading = embedded ? "h2" : "h1";
  const showDescription = task.description && task.description.trim() !== task.action_required.trim();
  const isOpen = OPEN_STATUSES.includes(task.status);
  // In the inbox the decision stays within reach at the bottom of the pane, however long the evidence is.
  const decisionBar = embedded && task.status === "candidate";

  const history = (
    <Fold title={t("detail.timeline")} count={task.events.length}>
      <Timeline events={task.events} timezone={timezone} />
    </Fold>
  );
  const technical = (
    <TechnicalDetails
      className="border-t pt-3"
      rows={[
        [t("detail.detectedAt"), formatDateTime(task.detected_at ?? task.created_at, i18n.language, timezone)],
        [
          t("detail.publishedAt"),
          task.source_published_day
            ? formatDate(task.source_published_day, i18n.language)
            : formatDateTime(task.source_published_at, i18n.language, timezone),
        ],
        [t("detail.updatedAt"), formatDateTime(task.updated_at, i18n.language, timezone)],
        [t("tech.score"), `${task.confidence.toFixed(2)} ${t("tech.uncalibrated")}`],
        [t("tech.reviewCodes"), task.review_reasons.join(", ") || "—"],
        [t("tech.actionType"), task.action_type],
        // Matching keys of the extractor (internal ids such as "enrollment_certificate"), not something to read.
        [t("detail.entities"), task.entities.join(", ") || "—"],
        ...(task.due_anchor ? [[t("due.anchor"), task.due_anchor] as [string, string]] : []),
        [t("tech.taskId"), task.id],
      ]}
    />
  );
  const calendar = isOpen ? (
    <CalendarCard task={task} />
  ) : task.status === "candidate" && task.due_date && !task.sample ? (
    <p className="flex items-center gap-2 border-t pt-3 text-[13px] text-muted-foreground">
      <CalendarClock className="size-4" /> {t("detail.calendarAfterConfirm")}
    </p>
  ) : task.calendar ? (
    <CalendarCard task={task} />
  ) : null;

  const main = (
    <div className="grid min-w-0 content-start gap-6">
      {issues.length ? (
        <Section title={t("detail.reviewTitle")}>
          <ul className="divide-y rounded-lg border border-urgent/25 bg-urgent/[0.04] px-3.5 py-3">
            {issues.map((issue) => (
              <IssueRow
                key={issue.kind}
                issue={issue}
                task={task}
                duplicate={issue.kind === "duplicate" ? duplicate : undefined}
                onEdit={() => setEditOpen(true)}
                onCompare={() => setCompareOpen(true)}
              />
            ))}
          </ul>
        </Section>
      ) : null}
      {duplicate && !issues.some((i) => i.kind === "duplicate") ? <SuggestionCard suggestion={{ ...duplicate, task_title: task.title }} showTask={false} /> : null}
      {otherSuggestions.length ? (
        <Section title={t("detail.suggestions")}>
          <div className="grid gap-2">
            {otherSuggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={{ ...s, task_title: task.title }} showTask={false} />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t("detail.basis")}>
        <Basis task={task} timezone={timezone} />
        {showDescription ? (
          <details className="group/ctx text-[13px]">
            <summary className="w-fit cursor-pointer list-none text-xs text-muted-foreground outline-none select-none hover:text-foreground focus-visible:underline [&::-webkit-details-marker]:hidden">
              <ChevronRight className="mr-1 inline size-3.5 transition-transform group-open/ctx:rotate-90" aria-hidden />
              {t("detail.context")}
            </summary>
            <p className="mt-1.5 leading-relaxed whitespace-pre-wrap text-muted-foreground">{task.description}</p>
          </details>
        ) : null}
      </Section>

      <Section title={t("detail.sourcesTitle")} aside={<span className="text-xs text-muted-foreground">{t("detail.sourcesCount", { count: task.sources.length })}</span>}>
        <SourceList sources={task.sources} timezone={timezone} openFirst={false} />
      </Section>
    </div>
  );

  const side = (
    <div className="grid content-start gap-3">
      {calendar}
      {history}
      {technical}
    </div>
  );

  return (
    <div className={cn("grid gap-6", embedded && "@container")}>
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StatusBadge status={task.status} />
          {task.sample ? (
            <Badge tone="outline">
              <FlaskConical /> {t("sample.badge")}
            </Badge>
          ) : null}
          <CategoryBadge category={task.category} />
          {task.manual ? <span className="text-xs text-muted-foreground">{t("detail.manual")}</span> : null}
          {task.links.length ? (
            <span className="text-xs text-muted-foreground">
              {t("detail.linkedTo")}{" "}
              {task.links.map((l, i) => (
                <span key={`${l.kind}-${l.task_id}`}>
                  {i ? listSeparator(i18n.language) : ""}
                  <Link to={`/tasks/${l.task_id}`} className="text-foreground/80 hover:underline">
                    {l.title}
                  </Link>
                </span>
              ))}
            </span>
          ) : null}
        </div>
        <div className="flex items-start gap-2">
          <Heading className={cn("min-w-0 flex-1 font-semibold tracking-tight break-words", embedded ? "text-xl leading-snug" : "text-page sm:text-2xl sm:leading-snug")}>
            {task.title}
          </Heading>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("detail.moreActions")} className="shrink-0">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                <Pencil /> {t("detail.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMergeOpen(true)}>
                <GitMerge /> {t("detail.merge")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => markSample.mutate(!task.sample)}>
                <FlaskConical /> {task.sample ? t("sample.unmark") : t("sample.mark")}
              </DropdownMenuItem>
              {embedded ? (
                <DropdownMenuItem onSelect={() => navigate(`/tasks/${task.id}`)}>
                  <ChevronRight /> {t("detail.openFullPage")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setDeleteOpen(true)}>
                <Trash2 /> {t("detail.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <DueLine task={task} />
        {task.sample ? (
          <p className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-[13px] leading-relaxed text-muted-foreground">
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden /> {t("sample.banner")}
          </p>
        ) : null}
        {!decisionBar ? (
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryActions task={task} onEdit={() => setEditOpen(true)} onDone={onDecided} />
          </div>
        ) : null}
      </header>

      {embedded ? (
        <div className="grid gap-6 @4xl:grid-cols-[minmax(0,1fr)_17rem] @4xl:gap-8">
          {main}
          {side}
        </div>
      ) : (
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
          {main}
          <aside className="grid content-start gap-3">
            {calendar}
            {history}
            {technical}
          </aside>
        </div>
      )}

      {decisionBar ? (
        <div className="sticky bottom-0 z-10 -mx-4 -mb-5 flex flex-wrap items-center gap-2 border-t bg-card/95 px-4 py-3 backdrop-blur-sm sm:-mx-8 sm:px-8">
          <PrimaryActions task={task} onEdit={() => setEditOpen(true)} onDone={onDecided} />
          <span className="ml-auto hidden text-xs text-muted-foreground xl:inline">{t("inbox.decisionHint")}</span>
        </div>
      ) : null}

      <TaskEditDialog open={editOpen} onOpenChange={setEditOpen} task={task} offerConfirm={task.status === "candidate"} />
      <MergeDialog task={task} open={mergeOpen} onOpenChange={setMergeOpen} />
      {duplicate ? (
        <DuplicateCompare suggestion={{ ...duplicate, task_title: task.title }} open={compareOpen} onOpenChange={setCompareOpen} onMerged={onDecided} />
      ) : null}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("detail.deleteTitle")}
        description={t("detail.deleteDescription")}
        confirmLabel={t("detail.deleteConfirm")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </div>
  );
}
