import {
  Ban,
  CalendarClock,
  Check,
  CircleCheck,
  CircleHelp,
  Ellipsis,
  GitMerge,
  Lock,
  Pencil,
  RotateCcw,
  SearchX,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { useAction, useTask } from "@/lib/queries";
import type { TaskDetail, TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CategoryBadge, ConfidenceMeter, PriorityBadge, ReviewReasonList, StatusBadge, UrgencyBadge } from "./badges";
import { CalendarCard } from "./CalendarCard";
import { URGENCY_TEXT } from "./meta";
import { useRelativeDueText } from "./useRelativeDueText";
import { MergeDialog } from "./MergeDialog";
import { SourceList } from "./SourceList";
import { StatusMenu } from "./StatusMenu";
import { SuggestionCard } from "./SuggestionCard";
import { TaskEditDialog } from "./TaskEditDialog";
import { Timeline } from "./Timeline";

function DueCard({ task }: { task: TaskDetail }) {
  const { t, i18n } = useTranslation();
  const relative = useRelativeDueText(task);
  const closed = task.status === "completed" || task.status === "dismissed";
  const locked = task.user_locked_fields.includes("due");
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-4 text-muted-foreground" /> {t("due.label")}
        </CardTitle>
        {locked ? (
          <Badge tone="outline" title={t("detail.locked")}>
            <Lock /> {t("detail.locked")}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3">
        {task.due_date ? (
          <div className="grid gap-1">
            <p className="text-xl font-semibold tracking-tight">
              {formatDate(task.due_date, i18n.language)}
              {task.due_time ? <span className="ml-2 tabular-nums">{task.due_time}</span> : null}
            </p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {relative && !closed ? <span className={cn("font-medium", URGENCY_TEXT[task.urgency])}>{relative}</span> : null}
              <span>{task.due_time ? t(`semantics.${task.time_semantics}`) : t("due.dateOnly")}</span>
              <span>
                {t("due.timezone")}: {task.timezone}
              </span>
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("due.none")}</p>
        )}
        {task.due_text ? (
          <p className="rounded-md bg-muted/60 px-3 py-2 text-[13px]">
            <span className="text-muted-foreground">{t("due.original")}: </span>“{task.due_text}”
          </p>
        ) : null}
        {task.due_is_relative ? (
          <p className="text-xs text-muted-foreground">
            {t("due.relative")}
            {task.due_anchor ? ` · ${t("due.anchor")}: ${task.due_anchor}` : ""}
          </p>
        ) : null}
        {task.due_needs_confirmation ? (
          <div className="flex gap-2 rounded-md border border-high/40 bg-high/10 px-3 py-2 text-[13px]">
            <CircleHelp className="mt-0.5 size-4 shrink-0 text-high" />
            <div className="grid gap-0.5">
              <p className="font-medium">{t("due.needsConfirmation")}</p>
              <p className="text-muted-foreground">{t("due.needsConfirmationHint")}</p>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function QuickActions({ task, onEdit }: { task: TaskDetail; onEdit: () => void }) {
  const { t } = useTranslation();
  const change = useAction((status: TaskStatus) => api.setStatus(task.id, status), { success: t("tasks.statusChanged") });
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
          <Button variant="ghost" size="sm" onClick={go("dismissed")} disabled={busy}>
            <Ban /> {t("statusAction.dismiss")}
          </Button>
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
        <Button variant="success" size="sm" onClick={go("completed")} disabled={busy}>
          <CircleCheck /> {t("statusAction.complete")}
        </Button>
      );
  }
}

export function TaskDetailView({ taskId, embedded = false, onDeleted }: { taskId: string; embedded?: boolean; onDeleted?: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const timezone = useTimezone();
  const { data: task, error, isLoading, refetch } = useTask(taskId);
  const [editOpen, setEditOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
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
  const Heading = embedded ? "h2" : "h1";
  const showDescription = task.description && task.description.trim() !== task.action_required.trim();

  const side = (
    <div className="grid content-start gap-4">
      <CalendarCard task={task} />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{t("detail.timeline")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Timeline events={task.events} timezone={timezone} />
        </CardContent>
      </Card>
      {task.links.length ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>{t("detail.links")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {task.links.map((l) => (
              <button
                key={`${l.kind}-${l.task_id}`}
                type="button"
                onClick={() => navigate(`/tasks/${l.task_id}`)}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <span className="truncate">{l.title}</span>
                <StatusBadge status={l.status} />
              </button>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-1 text-xs text-muted-foreground">
        <dt>{t("detail.detectedAt")}</dt>
        <dd>{formatDateTime(task.detected_at ?? task.created_at, i18n.language, timezone)}</dd>
        {task.source_published_at ? (
          <>
            <dt>{t("detail.publishedAt")}</dt>
            <dd>
              {task.source_published_day
                ? formatDate(task.source_published_day, i18n.language)
                : formatDateTime(task.source_published_at, i18n.language, timezone)}
            </dd>
          </>
        ) : null}
        <dt>{t("detail.updatedAt")}</dt>
        <dd>{formatDateTime(task.updated_at, i18n.language, timezone)}</dd>
        <dt>{t("common.confidence")}</dt>
        <dd>
          <ConfidenceMeter value={task.confidence} />
        </dd>
      </dl>
    </div>
  );

  return (
    <div className="grid gap-5">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={task.status} />
          <CategoryBadge category={task.category} />
          <PriorityBadge priority={task.priority} />
          {task.due_date && task.status !== "completed" && task.status !== "dismissed" ? <UrgencyBadge urgency={task.urgency} /> : null}
          {task.manual ? <Badge tone="outline">{t("detail.manual")}</Badge> : null}
        </div>
        <Heading className={cn("font-semibold tracking-tight", embedded ? "text-xl" : "text-2xl")}>{task.title}</Heading>
        <div className="flex flex-wrap items-center gap-2">
          <QuickActions task={task} onEdit={() => setEditOpen(true)} />
          <StatusMenu taskId={task.id} status={task.status} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("common.actions")}>
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
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setDeleteOpen(true)}>
                <Trash2 /> {t("detail.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {task.needs_review && task.review_reasons.length ? (
        <div className="grid gap-2 rounded-lg border border-high/40 bg-high/8 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <TriangleAlert className="size-4 text-high" /> {t("detail.reviewTitle")}
          </p>
          <p className="text-[13px] text-muted-foreground">{t("detail.reviewHint")}</p>
          <ReviewReasonList reasons={task.review_reasons} />
        </div>
      ) : null}

      <div className={cn("grid gap-5", !embedded && "xl:grid-cols-[minmax(0,1fr)_22rem]")}>
        <div className="grid min-w-0 content-start gap-5">
          <DueCard task={task} />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>{t("detail.actionRequired")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{task.action_required || task.title}</p>
              {showDescription ? (
                <div className="grid gap-1">
                  <p className="text-xs font-medium text-muted-foreground">{t("detail.description")}</p>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">{task.description}</p>
                </div>
              ) : null}
              {task.entities.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">{t("detail.entities")}:</span>
                  {task.entities.map((e) => (
                    <Badge key={e} tone="outline">
                      {e}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>

          {pending.length ? (
            <section className="grid gap-3">
              <h2 className="text-base font-semibold">{t("detail.suggestions")}</h2>
              {pending.map((s) => (
                <SuggestionCard key={s.id} suggestion={s} showTask={false} />
              ))}
            </section>
          ) : null}

          <section className="grid gap-3">
            <div className="grid gap-0.5">
              <h2 className="text-base font-semibold">{t("detail.sourcesTitle")}</h2>
              <CardDescription>{t("detail.sourcesHint")}</CardDescription>
            </div>
            <SourceList sources={task.sources} timezone={timezone} />
          </section>
          {embedded ? side : null}
        </div>
        {embedded ? null : side}
      </div>

      <TaskEditDialog open={editOpen} onOpenChange={setEditOpen} task={task} offerConfirm={task.status === "candidate"} />
      <MergeDialog task={task} open={mergeOpen} onOpenChange={setMergeOpen} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("detail.deleteTitle")}
        description={t("detail.deleteDescription")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </div>
  );
}
