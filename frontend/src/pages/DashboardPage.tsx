import { ArrowRight, CircleCheckBig, FlaskConical, Play, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { STATUS_ICON, STATUS_TEXT } from "@/components/tasks/meta";
import { CompleteToggle, StatusMenu } from "@/components/tasks/StatusMenu";
import { TaskEditDialog } from "@/components/tasks/TaskEditDialog";
import { TaskListItem } from "@/components/tasks/TaskRow";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/menu";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useAction, useDashboard } from "@/lib/queries";
import { LANES, type AttentionReason, type AttentionTask, type Dashboard, type Lane, type TaskStatus, type TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const GROUPS: AttentionReason[] = ["overdue", "due_today", "due_tomorrow", "due_soon"];
const GROUP_TONE: Record<AttentionReason, string> = {
  overdue: "text-overdue",
  due_today: "text-urgent",
  due_tomorrow: "text-urgent",
  due_soon: "text-muted-foreground",
};
/** The status each lane stands for (its icon and colour), and where "show all" leads. */
const LANE_STATUS: Record<Lane, TaskStatus> = { todo: "confirmed", in_progress: "in_progress", waiting_for_reply: "waiting_for_reply" };

/** "Start" on a to-do: the one step that moves it to "in progress", right where it is. */
function StartButton({ task }: { task: TaskSummary }) {
  const { t } = useTranslation();
  const start = useAction(() => api.setStatus(task.id, "in_progress"), {
    success: (r) => t("detail.statusDone.in_progress", { title: r.title }),
    undo: (r) => r.undo_event_id,
  });
  return (
    <Tip content={t("dashboard.startHint")}>
      <Button
        variant="ghost"
        size="xs"
        className="touch-target relative text-muted-foreground"
        onClick={() => start.mutate(undefined)}
        disabled={start.isPending}
        aria-label={t("dashboard.startTask", { title: task.title })}
      >
        <Play /> {t("dashboard.start")}
      </Button>
    </Tip>
  );
}

function Row({ task, lane }: { task: TaskSummary; lane?: Lane }) {
  return (
    <TaskListItem
      task={task}
      hideStatus={lane !== undefined && lane !== "todo"}
      leading={<CompleteToggle task={task} />}
      actions={
        <>
          {lane === "todo" ? <StartButton task={task} /> : null}
          <StatusMenu taskId={task.id} title={task.title} status={task.status} variant="more" />
        </>
      }
    />
  );
}

/** What is (nearly) due, most pressing first; each task shows its status, so "in progress" is never hidden. */
function AttentionList({ items }: { items: AttentionTask[] }) {
  const { t } = useTranslation();
  const groups = GROUPS.map((g) => ({ group: g, tasks: items.filter((task) => task.attention === g) })).filter((g) => g.tasks.length);
  return (
    <div className="grid gap-4">
      {groups.map(({ group, tasks }) => (
        <section key={group} aria-label={t(`dashboard.group.${group}`)} className="grid gap-0.5">
          <h3 className={cn("flex items-center gap-2 border-b px-3 pb-1.5 text-xs font-semibold", GROUP_TONE[group])}>
            {t(`dashboard.group.${group}`)}
            <span className="font-normal text-muted-foreground tabular-nums">{tasks.length}</span>
          </h3>
          <ul className="grid gap-px">
            {tasks.map((task) => (
              <li key={task.id}>
                <Row task={task} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One lane of the board: the tasks with one status, earliest deadline first. */
function LaneCard({ lane, tasks, count }: { lane: Lane; tasks: TaskSummary[]; count: number }) {
  const { t } = useTranslation();
  const status = LANE_STATUS[lane];
  const Icon = STATUS_ICON[status];
  return (
    <section aria-labelledby={`lane-${lane}`} className="grid min-w-0 content-start gap-1 rounded-lg bg-subtle p-2">
      <div className="flex min-h-8 items-center gap-2 px-2">
        <Icon className={cn("size-4", STATUS_TEXT[status])} aria-hidden />
        <h3 id={`lane-${lane}`} className="text-sm font-semibold">
          {t(`dashboard.lane.${lane}`)}
        </h3>
        <span className="text-[13px] text-muted-foreground tabular-nums">{count}</span>
      </div>
      {tasks.length ? (
        <ul className="grid gap-1">
          {tasks.map((task) => (
            <li key={task.id} className="rounded-md bg-card">
              <Row task={task} lane={lane} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 pb-2 text-[13px] leading-relaxed text-muted-foreground">{t(`dashboard.laneEmpty.${lane}`)}</p>
      )}
      {count > tasks.length ? (
        <Button variant="ghost" size="xs" asChild className="w-fit text-muted-foreground">
          <Link to={`/tasks?status=${lane}`}>
            {t("dashboard.laneMore", { count })} <ArrowRight />
          </Link>
        </Button>
      ) : null}
    </section>
  );
}

/** One sentence: how many tasks are overdue or due soon, and how many are being worked on. */
function summaryLine(data: Dashboard, t: TFunction): string {
  const c = data.counts;
  const parts = [
    c.overdue ? t("dashboard.summaryOverdue", { count: c.overdue }) : null,
    c.due_today ? t("dashboard.summaryToday", { count: c.due_today }) : null,
    c.due_tomorrow ? t("dashboard.summaryTomorrow", { count: c.due_tomorrow }) : null,
    c.due_soon ? t("dashboard.summaryWeek", { count: c.due_soon }) : null,
  ].filter(Boolean);
  const working = c.in_progress ? t("dashboard.summaryWorking", { count: c.in_progress }) : "";
  if (!parts.length) return c.active ? t("dashboard.summaryNothingDue", { count: c.active }) + working : t("dashboard.summaryNone");
  return parts.join(t("dashboard.summaryJoin")) + working;
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { data, error, isLoading, refetch } = useDashboard();
  const [addOpen, setAddOpen] = useState(false);

  if (isLoading) return <LoadingRows rows={6} />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const counts = data.counts;
  const attention = data.attention;
  const nothingYet = counts.active === 0 && data.completed_recent.length === 0;

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-page font-semibold">{t("dashboard.greeting", { date: formatDate(data.today, i18n.language) })}</h1>
        <p className="text-sm text-muted-foreground">{summaryLine(data, t)}</p>
        {counts.sample_open ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <FlaskConical className="size-3.5" aria-hidden />
            {t("sample.dashboardNote", { count: counts.sample_open })}
            <Link to="/tasks?status=all&sample=1" className="font-medium text-foreground/80 hover:underline">
              {t("sample.showThem")}
            </Link>
          </p>
        ) : null}
      </header>

      {nothingYet ? (
        <EmptyState
          icon={CircleCheckBig}
          title={t("dashboard.emptyTitle")}
          description={t("dashboard.emptyHint")}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => setAddOpen(true)}>
                <Plus /> {t("newTask.button")}
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/settings?section=guide">{t("dashboard.openGuide")}</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <>
          {attention.length ? (
            <section className="grid min-w-0 content-start gap-2">
              <div className="flex min-h-8 items-center justify-between gap-2">
                <h2 className="text-section font-semibold">{t("dashboard.attention")}</h2>
                {data.attention_total > attention.length ? (
                  <Button variant="ghost" size="xs" asChild>
                    <Link to="/tasks?sort=urgency">
                      {t("dashboard.attentionMore", { count: data.attention_total - attention.length })} <ArrowRight />
                    </Link>
                  </Button>
                ) : null}
              </div>
              <AttentionList items={attention} />
            </section>
          ) : null}

          <section className="grid min-w-0 gap-2" aria-labelledby="board-title">
            <div className="flex min-h-8 items-center justify-between gap-2">
              <h2 id="board-title" className="text-section font-semibold">
                {t("dashboard.board")}
              </h2>
              <Button variant="ghost" size="xs" asChild>
                <Link to="/tasks">
                  {t("dashboard.allOpen", { count: counts.active })} <ArrowRight />
                </Link>
              </Button>
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              {LANES.map((lane) => (
                <LaneCard key={lane} lane={lane} tasks={data.lanes[lane]} count={counts[lane]} />
              ))}
            </div>
          </section>

          {data.completed_recent.length ? (
            <section className="grid min-w-0 gap-1" aria-labelledby="done-title">
              <div className="flex min-h-8 items-center justify-between gap-2">
                <h2 id="done-title" className="text-sm font-semibold text-muted-foreground">
                  {t("dashboard.completedWeek", { count: counts.completed_7d })}
                </h2>
                <Button variant="ghost" size="xs" asChild>
                  <Link to="/tasks?status=completed">
                    {t("dashboard.showCompleted")} <ArrowRight />
                  </Link>
                </Button>
              </div>
              <ul className="grid gap-px">
                {data.completed_recent.map((task) => (
                  <li key={task.id}>
                    <TaskListItem task={task} leading={<CompleteToggle task={task} />} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      <TaskEditDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
