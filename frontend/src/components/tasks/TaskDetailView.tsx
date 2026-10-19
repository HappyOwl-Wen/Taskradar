import { CalendarClock, ChevronRight, CircleCheck, Ellipsis, FlaskConical, Lock, Pencil, RotateCcw, SearchX, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tip } from "@/components/ui/menu";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api, ApiError } from "@/lib/api";
import { formatDate, listSeparator } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { useAction, useTask } from "@/lib/queries";
import type { TaskDetail, TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CategoryBadge, StatusBadge } from "./badges";
import { CalendarCard } from "./CalendarCard";
import { DeleteTasksDialog } from "./DeleteTaskDialog";
import { URGENCY_TEXT } from "./meta";
import { SourceList } from "./SourceList";
import { StatusMenu } from "./StatusMenu";
import { TaskEditDialog, type EditFocus } from "./TaskEditDialog";
import { Timeline } from "./Timeline";
import { useRelativeDueText } from "./useRelativeDueText";

const OPEN_STATUSES: TaskStatus[] = ["candidate", "confirmed", "in_progress", "waiting_for_reply"];

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

function PrimaryActions({ task, onDone, onDeleted }: { task: TaskDetail; onDone?: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const change = useAction((status: TaskStatus) => api.setStatus(task.id, status), {
    success: (r) => t(`detail.statusDone.${r.status}`, { title: r.title }),
    undo: (r) => r.undo_event_id,
    onSuccess: onDone,
  });
  const go = (status: TaskStatus) => () => change.mutate(status);
  const busy = change.isPending;
  const menu = <StatusMenu taskId={task.id} title={task.title} status={task.status} onDeleted={onDeleted} />;
  switch (task.status) {
    case "completed":
      return (
        <>
          <Button variant="outline" size="sm" onClick={go("confirmed")} disabled={busy}>
            <RotateCcw /> {t("statusAction.reopen")}
          </Button>
          {menu}
        </>
      );
    case "dismissed":
      return (
        <>
          <Button variant="outline" size="sm" onClick={go("confirmed")} disabled={busy}>
            <RotateCcw /> {t("statusAction.restore")}
          </Button>
          {menu}
        </>
      );
    default:
      return (
        <>
          <Button size="sm" onClick={go("completed")} disabled={busy}>
            <CircleCheck /> {t("statusAction.complete")}
          </Button>
          {menu}
        </>
      );
  }
}

/** Where an earlier version found the task: the quoted sentences of each mail or file, read-only. */
function OldSources({ task, timezone }: { task: TaskDetail; timezone: string }) {
  const { t } = useTranslation();
  if (task.sources.length === 0) return null;
  return (
    <section className="grid min-w-0 grid-cols-1 gap-2.5">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-semibold">{t("detail.sourcesTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("detail.sourcesHint")}</p>
      </div>
      <SourceList sources={task.sources} timezone={timezone} openFirst={false} />
    </section>
  );
}

export function TaskDetailView({
  taskId,
  embedded = false,
  onDeleted,
  focusTitle = false,
}: {
  taskId: string;
  /** Shown next to a list (one column, smaller heading). */
  embedded?: boolean;
  onDeleted?: () => void;
  /** Put the keyboard focus on the title once the task is shown (a clear starting point after moving on). */
  focusTitle?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const timezone = useTimezone();
  const { data: task, error, isLoading, refetch } = useTask(taskId);
  const [edit, setEdit] = useState<EditFocus | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const shown = Boolean(task);
  useEffect(() => {
    if (focusTitle && shown) title.current?.focus({ preventScroll: true });
  }, [focusTitle, shown]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const afterDelete = () => (onDeleted ? onDeleted() : navigate("/tasks"));
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

  const Heading = embedded ? "h2" : "h1";
  // What to do, when it says more than the title; the description as the user wrote it.
  const action = task.action_required.trim();
  const showAction = action && action !== task.title.trim();
  const description = task.description.trim();
  const isOpen = OPEN_STATUSES.includes(task.status);

  const history = (
    <Fold title={t("detail.timeline")} count={task.events.length}>
      <Timeline events={task.events} timezone={timezone} />
    </Fold>
  );
  const calendar = isOpen || task.calendar ? <CalendarCard task={task} /> : null;

  const main = (
    <div className="grid min-w-0 grid-cols-1 content-start gap-6">
      {showAction || description ? (
        <section className="grid min-w-0 grid-cols-1 gap-2">
          <h3 className="text-sm font-semibold">{t("detail.notes")}</h3>
          {showAction ? <p className="text-sm leading-relaxed whitespace-pre-wrap">{action}</p> : null}
          {description ? <p className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">{description}</p> : null}
        </section>
      ) : (
        <button
          type="button"
          onClick={() => setEdit("title")}
          className="w-fit rounded-md text-left text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          {t("detail.addNotes")}
        </button>
      )}
      <OldSources task={task} timezone={timezone} />
    </div>
  );

  const side = (
    <div className="grid min-w-0 grid-cols-1 content-start gap-3">
      {calendar}
      {history}
    </div>
  );

  return (
    <div className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6", embedded && "@container")}>
      <header className="grid min-w-0 grid-cols-1 gap-3">
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
          <Heading
            ref={title}
            tabIndex={-1}
            className={cn("min-w-0 flex-1 font-semibold tracking-tight outline-none [overflow-wrap:anywhere]", embedded ? "text-xl leading-snug" : "text-page sm:text-2xl sm:leading-snug")}
          >
            {task.title}
          </Heading>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("detail.moreActions")} className="shrink-0">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEdit("title")}>
                <Pencil /> {t("detail.edit")}
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <DueLine task={task} />
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setEdit("date")}>
            <Pencil /> {task.due_date ? t("detail.changeDate") : t("detail.setDate")}
          </Button>
        </div>
        {task.sample ? (
          <p className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-[13px] leading-relaxed text-muted-foreground">
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden /> {t("sample.banner")}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <PrimaryActions task={task} onDeleted={afterDelete} />
        </div>
      </header>

      {embedded ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 self-start @4xl:grid-cols-[minmax(0,1fr)_17rem] @4xl:gap-8">
          {main}
          {side}
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
          {main}
          <aside className="grid min-w-0 grid-cols-1 content-start gap-3">
            {calendar}
            {history}
          </aside>
        </div>
      )}

      <TaskEditDialog open={edit !== null} onOpenChange={(o) => !o && setEdit(null)} task={task} focus={edit ?? "title"} />
      <DeleteTasksDialog ids={[task.id]} title={task.title} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={afterDelete} />
    </div>
  );
}
