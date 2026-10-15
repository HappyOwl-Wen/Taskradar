import {
  Ban,
  CalendarClock,
  Check,
  ChevronRight,
  CircleCheck,
  Columns2,
  Ellipsis,
  GitMerge,
  Lock,
  Pencil,
  RotateCcw,
  SearchX,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tip } from "@/components/ui/menu";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { useAction, useTask } from "@/lib/queries";
import { taskIssues, type Issue } from "@/lib/review";
import type { Suggestion, TaskDetail, TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CategoryBadge, StatusBadge } from "./badges";
import { CalendarCard } from "./CalendarCard";
import { DuplicateCompare } from "./DuplicateCompare";
import { EvidenceList } from "./Evidence";
import { MergeDialog } from "./MergeDialog";
import { ISSUE_ICON, URGENCY_TEXT } from "./meta";
import { SourceList } from "./SourceList";
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
        <h3 className="text-[13px] font-semibold text-muted-foreground">{title}</h3>
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
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
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

function IssueRow({ issue, task, duplicate, onEdit, onCompare }: { issue: Issue; task: TaskDetail; duplicate?: Suggestion; onEdit: () => void; onCompare: () => void }) {
  const { t } = useTranslation();
  const Icon = ISSUE_ICON[issue.kind];
  const other = duplicate ? (typeof duplicate.payload.other_title === "string" ? duplicate.payload.other_title : duplicate.related_task_title) : null;
  let text: string = t(`issue.${issue.kind}.hint`);
  let action: ReactNode = null;
  if (issue.kind === "duplicate" && duplicate) {
    text = t("issue.duplicate.withTitle", { title: other ?? "—" });
    action = (
      <Button variant="outline" size="xs" onClick={onCompare}>
        <Columns2 /> {t("compare.viewDiff")}
      </Button>
    );
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
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
      <Icon className={cn("mt-0.5 size-4 shrink-0", issue.kind === "date_conflict" ? "text-overdue" : "text-high")} aria-hidden />
      <div className="grid min-w-0 flex-1 basis-60 gap-0.5">
        <p className="text-sm font-medium">{t(`issue.${issue.kind}.label`)}</p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{text}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

/** The quote that shows why this is a task: the action (and deadline) sentence of the first source. */
function KeyEvidence({ task }: { task: TaskDetail }) {
  const quotes = task.sources[0]?.evidence.filter((e) => e.kind === "action" || e.kind === "deadline").slice(0, 2) ?? [];
  if (quotes.length === 0) return null;
  return <EvidenceList evidence={quotes} />;
}

export function TaskDetailView({
  taskId,
  embedded = false,
  onDeleted,
  onDecided,
}: {
  taskId: string;
  /** Shown next to a list (one column, smaller heading). */
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
  const actionText = task.action_required || task.title;

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
        ...(task.due_anchor ? [[t("due.anchor"), task.due_anchor] as [string, string]] : []),
        [t("tech.taskId"), task.id],
      ]}
    />
  );
  const calendar = isOpen ? (
    <CalendarCard task={task} />
  ) : task.status === "candidate" && task.due_date ? (
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
          <ul className="divide-y rounded-lg border border-high/35 bg-high/5 px-3.5 py-3">
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

      <Section title={t("detail.actionRequired")}>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{actionText}</p>
        {showDescription ? (
          <details className="group/ctx text-[13px]">
            <summary className="w-fit cursor-pointer list-none text-xs text-muted-foreground outline-none select-none hover:text-foreground focus-visible:underline [&::-webkit-details-marker]:hidden">
              <ChevronRight className="mr-1 inline size-3.5 transition-transform group-open/ctx:rotate-90" aria-hidden />
              {t("detail.context")}
            </summary>
            <p className="mt-1.5 leading-relaxed whitespace-pre-wrap text-muted-foreground">{task.description}</p>
          </details>
        ) : null}
        {task.entities.length ? (
          <p className="text-xs text-muted-foreground">
            {t("detail.entities")}: <span className="text-foreground/80">{task.entities.join(" · ")}</span>
          </p>
        ) : null}
        <KeyEvidence task={task} />
      </Section>

      <Section title={t("detail.sourcesTitle")} aside={<span className="text-xs text-muted-foreground">{t("detail.sourcesCount", { count: task.sources.length })}</span>}>
        <SourceList sources={task.sources} timezone={timezone} openFirst={false} />
      </Section>
    </div>
  );

  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StatusBadge status={task.status} />
          <CategoryBadge category={task.category} />
          {task.manual ? <span className="text-xs text-muted-foreground">{t("detail.manual")}</span> : null}
          {task.links.length ? (
            <span className="text-xs text-muted-foreground">
              {t("detail.linkedTo")}{" "}
              {task.links.map((l, i) => (
                <span key={`${l.kind}-${l.task_id}`}>
                  {i ? "、" : ""}
                  <Link to={`/tasks/${l.task_id}`} className="text-foreground/80 hover:underline">
                    {l.title}
                  </Link>
                </span>
              ))}
            </span>
          ) : null}
        </div>
        <Heading className={cn("font-semibold tracking-tight break-words", embedded ? "text-lg leading-snug" : "text-xl leading-snug sm:text-2xl")}>{task.title}</Heading>
        <DueLine task={task} />
        <div className="flex flex-wrap items-center gap-2">
          <PrimaryActions task={task} onEdit={() => setEditOpen(true)} onDone={onDecided} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("detail.moreActions")}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                <Pencil /> {t("detail.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMergeOpen(true)}>
                <GitMerge /> {t("detail.merge")}
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
      </header>

      {embedded ? (
        <>
          {main}
          <div className="grid gap-3">
            {calendar}
            {history}
            {technical}
          </div>
        </>
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
