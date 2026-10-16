import {
  ArrowRight,
  CalendarRange,
  CircleCheck,
  CircleCheckBig,
  Columns2,
  FlaskConical,
  FolderPlus,
  Inbox,
  Mail,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { UploadButton } from "@/components/layout/TopBar";
import { SystemStatusCard } from "@/components/layout/SystemStatus";
import { conflictState, dateChangedState, unconfirmedState, type KeyState } from "@/components/tasks/keyStates";
import { DuplicateCompare } from "@/components/tasks/DuplicateCompare";
import { TaskListItem } from "@/components/tasks/TaskRow";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { formatDate, formatDue } from "@/lib/format";
import { expectSourceActivity, useAction, useDashboard } from "@/lib/queries";
import type { AttentionReason, AttentionTask, Dashboard, Suggestion } from "@/lib/types";
import { cn } from "@/lib/utils";

function MetricTile({ label, value, sub, icon: Icon, tone, to }: { label: string; value: number; sub?: string; icon: LucideIcon; tone: string; to: string }) {
  return (
    <Link
      to={to}
      className="group grid gap-1 rounded-lg border bg-card px-4 py-3 transition-colors outline-none hover:border-input hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/40"
    >
      <span className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground">
        {label}
        <Icon className={cn("size-4", value > 0 ? tone : "text-muted-foreground/60")} aria-hidden />
      </span>
      <span className={cn("text-2xl leading-tight font-semibold tabular-nums", value > 0 && tone)}>{value}</span>
      <span className="min-h-4 text-xs text-muted-foreground">{sub}</span>
    </Link>
  );
}

/** The time group decides the order; conflicts and changed dates only get their own group when not due soon. */
const GROUPS: AttentionReason[] = ["overdue", "due_today", "due_tomorrow", "due_soon", "date_changed", "conflict"];
const GROUP_TONE: Record<AttentionReason, string> = {
  overdue: "text-overdue",
  due_today: "text-urgent",
  due_tomorrow: "text-urgent",
  due_soon: "text-muted-foreground",
  date_changed: "text-urgent",
  conflict: "text-urgent",
};

function groupOf(task: AttentionTask): AttentionReason {
  // A server that has not been restarted yet still sends the old reasons.
  if (task.attention === "unconfirmed_due") return task.urgency === "overdue" ? "overdue" : "due_soon";
  return task.attention;
}

/** Unconfirmed tasks are always marked as such; a disputed or changed date is named too (at most two states). */
function attentionStates(task: AttentionTask, t: TFunction): KeyState[] {
  const flags = task.attention_flags ?? [];
  return [
    ...(task.status === "candidate" ? [unconfirmedState(t)] : []),
    ...(flags.includes("conflict") ? [conflictState(t)] : []),
    ...(flags.includes("date_changed") ? [dateChangedState(t)] : []),
  ];
}

function AttentionList({ items }: { items: AttentionTask[] }) {
  const { t } = useTranslation();
  const groups = GROUPS.map((g) => ({ group: g, tasks: items.filter((task) => groupOf(task) === g) })).filter((g) => g.tasks.length);
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {groups.map(({ group, tasks }) => (
        <section key={group} aria-label={t(`dashboard.group.${group}`)} className="border-b last:border-b-0">
          <h3 className={cn("flex items-center gap-2 bg-muted/50 px-4 py-1.5 text-xs font-semibold", GROUP_TONE[group])}>
            {t(`dashboard.group.${group}`)}
            <span className="font-normal text-muted-foreground tabular-nums">{tasks.length}</span>
          </h3>
          <ul className="grid gap-px p-1">
            {tasks.map((task) => (
              <li key={task.id}>
                <TaskListItem
                  task={task}
                  to={task.status === "candidate" ? `/inbox?task=${task.id}` : `/tasks/${task.id}`}
                  states={attentionStates(task, t)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function shortDue(date: string | null | undefined, time: string | null | undefined, language: string): string | null {
  return date ? formatDue({ due_date: date, due_time: time ?? null }, language, new Date().getFullYear()) : null;
}

/** A pending suggestion with what it is about: both task titles, their deadlines and the reason. */
function SuggestionItem({ suggestion, onCompare }: { suggestion: Suggestion; onCompare: (s: Suggestion) => void }) {
  const { t, i18n } = useTranslation();
  const s = suggestion;
  const taskDue = shortDue(s.task_due_date, s.task_due_time, i18n.language);
  const relatedDue = shortDue(s.related_due_date, s.related_due_time, i18n.language);
  const title = s.task_title ?? "—";
  const taskLink = s.task_status === "candidate" ? `/inbox?task=${s.task_id}` : `/tasks/${s.task_id}`;
  let heading: string = t(`suggestionCard.${s.kind}.title`);
  let detail: ReactNode;
  if (s.kind === "possible_duplicate") {
    heading = s.deadlines_differ ? t("dashboard.suggestion.duplicateDates") : t("dashboard.suggestion.duplicate");
    detail = (
      <>
        <p className="text-[13px] leading-snug break-words">
          <span className="font-medium">{t("dashboard.suggestion.quoted", { title })}</span>
          {taskDue ? <span className={cn("ml-1.5 whitespace-nowrap tabular-nums", s.deadlines_differ ? "text-urgent" : "text-muted-foreground")}>{taskDue}</span> : null}
        </p>
        <p className="text-[13px] leading-snug break-words text-muted-foreground">
          {t("dashboard.suggestion.and")} <span className="text-foreground">{t("dashboard.suggestion.quoted", { title: s.related_task_title ?? "—" })}</span>
          {relatedDue ? <span className={cn("ml-1.5 whitespace-nowrap tabular-nums", s.deadlines_differ && "text-urgent")}>{relatedDue}</span> : null}
        </p>
      </>
    );
  } else if (s.kind === "update_due") {
    const to = shortDue(
      typeof s.payload.due_date === "string" ? s.payload.due_date : null,
      typeof s.payload.due_time === "string" ? s.payload.due_time : null,
      i18n.language,
    );
    detail = (
      <p className="text-[13px] leading-snug break-words">
        <span className="font-medium">{t("dashboard.suggestion.quoted", { title })}</span>{" "}
        <span className="whitespace-nowrap text-muted-foreground tabular-nums">
          {taskDue ?? t("due.none")} → <span className="text-urgent">{to ?? "—"}</span>
        </span>
      </p>
    );
  } else {
    detail = (
      <p className="text-[13px] leading-snug break-words">
        <span className="font-medium">{t("dashboard.suggestion.quoted", { title })}</span>
      </p>
    );
  }
  const review =
    s.kind === "possible_duplicate" ? (
      <Button variant="outline" size="xs" onClick={() => onCompare(s)}>
        <Columns2 /> {t("dashboard.suggestion.compare")}
      </Button>
    ) : (
      <Button variant="outline" size="xs" asChild>
        <Link to={taskLink}>{t("dashboard.suggestion.review")}</Link>
      </Button>
    );
  return (
    <li className="grid gap-1 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="pt-0.5 text-xs font-semibold text-muted-foreground">{heading}</p>
        {review}
      </div>
      {detail}
    </li>
  );
}

function Suggestions({ data }: { data: Dashboard }) {
  const { t } = useTranslation();
  const [comparing, setComparing] = useState<Suggestion | null>(null);
  if (!data.suggestions.length) return null;
  return (
    <section className="grid gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h2 className="text-section font-semibold">
          {t("dashboard.suggestions")} <span className="font-normal text-muted-foreground tabular-nums">{data.counts.pending_suggestions}</span>
        </h2>
        <Button variant="ghost" size="xs" asChild>
          <Link to="/inbox?tab=suggestions">
            {t("common.viewAll")} <ArrowRight />
          </Link>
        </Button>
      </div>
      <ul className="divide-y rounded-lg border bg-card">
        {data.suggestions.slice(0, 4).map((s) => (
          <SuggestionItem key={s.id} suggestion={s} onCompare={setComparing} />
        ))}
      </ul>
      {comparing ? <DuplicateCompare suggestion={comparing} open onOpenChange={(open) => !open && setComparing(null)} /> : null}
    </section>
  );
}

function Onboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const demo = useAction(
    async () => {
      const source = await api.createDemoMailbox();
      await api.syncSource(source.id);
      return source;
    },
    {
      success: t("onboarding.demoCreated"),
      onSuccess: () => {
        expectSourceActivity();
        navigate("/sources");
      },
    },
  );
  const steps: { icon: LucideIcon; title: string; hint: string; action: ReactNode }[] = [
    {
      icon: FlaskConical,
      title: t("onboarding.demo"),
      hint: t("onboarding.demoHint"),
      action: (
        <Button variant="outline" size="sm" onClick={() => demo.mutate(undefined)} disabled={demo.isPending}>
          {demo.isPending ? <RefreshCw className="animate-spin" /> : <FlaskConical />} {t("onboarding.demo")}
        </Button>
      ),
    },
    {
      icon: Mail,
      title: t("onboarding.gmail"),
      hint: t("onboarding.gmailHint"),
      action: (
        <Button variant="outline" size="sm" asChild>
          <Link to="/settings?section=gmail">
            <Mail /> {t("onboarding.gmail")}
          </Link>
        </Button>
      ),
    },
    {
      icon: FolderPlus,
      title: t("onboarding.folder"),
      hint: t("onboarding.folderHint"),
      action: (
        <Button variant="outline" size="sm" asChild>
          <Link to="/sources#folders">
            <FolderPlus /> {t("onboarding.folder")}
          </Link>
        </Button>
      ),
    },
  ];
  return (
    <section className="grid gap-4 rounded-lg border bg-card p-5">
      <div className="grid gap-1">
        <h2 className="text-section font-semibold">{t("onboarding.title")}</h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{t("onboarding.description")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="grid content-between gap-3 rounded-md border p-3.5">
          <div className="grid gap-1">
            <p className="text-sm font-medium">{t("onboarding.upload")}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("onboarding.uploadHint")}</p>
          </div>
          <UploadButton variant="outline" />
        </div>
        {steps.map((s) => (
          <div key={s.title} className="grid content-between gap-3 rounded-md border p-3.5">
            <div className="grid gap-1">
              <p className="text-sm font-medium">{s.title}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{s.hint}</p>
            </div>
            <div>{s.action}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function isEmptyWorkspace(d: Dashboard): boolean {
  return d.counts.active + d.counts.candidates + d.counts.completed_7d === 0 && d.recent_jobs.length === 0;
}

/** One sentence: how many tasks need attention, by how soon, and how many of them are unconfirmed. */
function summaryLine(data: Dashboard, t: TFunction): string {
  const counts = data.attention_counts;
  if (!counts) {
    // Older server: the coarse counts.
    const parts = [
      data.counts.overdue ? t("dashboard.summaryOverdue", { count: data.counts.overdue }) : null,
      data.counts.due_soon ? t("dashboard.summaryDueSoon", { count: data.counts.due_soon }) : null,
    ].filter(Boolean);
    return parts.length ? parts.join(t("dashboard.summaryJoin")) : t("dashboard.summaryNone");
  }
  const parts = [
    counts.overdue ? t("dashboard.summaryOverdue", { count: counts.overdue }) : null,
    counts.due_today ? t("dashboard.summaryToday", { count: counts.due_today }) : null,
    counts.due_tomorrow ? t("dashboard.summaryTomorrow", { count: counts.due_tomorrow }) : null,
    counts.due_soon ? t("dashboard.summaryWeek", { count: counts.due_soon }) : null,
  ].filter(Boolean);
  if (!parts.length) return t("dashboard.summaryNone");
  const unconfirmed = data.attention_unconfirmed ?? 0;
  return parts.join(t("dashboard.summaryJoin")) + (unconfirmed ? t("dashboard.summaryUnconfirmed", { count: unconfirmed }) : "");
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { data, error, isLoading, refetch } = useDashboard();

  if (isLoading) return <LoadingRows rows={6} />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const counts = data.counts;
  const c = {
    ...counts,
    needs_action: counts.needs_action ?? counts.candidates + counts.pending_suggestions,
    due_soon: counts.due_soon ?? counts.upcoming_7d,
    due_soon_candidates: counts.due_soon_candidates ?? 0,
    overdue_candidates: counts.overdue_candidates ?? 0,
    sample_open: counts.sample_open ?? 0,
  };
  const attention = data.attention ?? [];
  const shown = attention.length;
  const attentionTotal = data.attention_total ?? shown;

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-page font-semibold">{t("dashboard.greeting", { date: formatDate(data.today, i18n.language) })}</h1>
        <p className="text-sm text-muted-foreground">
          {summaryLine(data, t)}
          {c.needs_action ? (
            <>
              {t("dashboard.summaryJoin")}
              <Link to="/inbox" className="font-medium text-violet hover:underline">
                {t("dashboard.summaryNeedsAction", { count: c.needs_action })}
              </Link>
            </>
          ) : null}
        </p>
        {c.sample_open ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <FlaskConical className="size-3.5" aria-hidden />
            {t("sample.dashboardNote", { count: c.sample_open })}
            <Link to="/tasks?view=all&sample=1" className="font-medium text-foreground/80 hover:underline">
              {t("sample.showThem")}
            </Link>
          </p>
        ) : null}
      </header>

      {isEmptyWorkspace(data) ? <Onboarding /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile
          label={t("dashboard.metric.needsAction")}
          value={c.needs_action}
          sub={
            c.needs_action
              ? [c.candidates ? t("dashboard.metric.candidates", { count: c.candidates }) : null, c.pending_suggestions ? t("dashboard.metric.suggestions", { count: c.pending_suggestions }) : null]
                  .filter(Boolean)
                  .join(" · ")
              : t("dashboard.metric.nothingToDecide")
          }
          icon={Inbox}
          tone="text-violet"
          to="/inbox"
        />
        <MetricTile
          label={t("dashboard.metric.dueSoon")}
          value={c.due_soon}
          sub={c.due_soon_candidates ? t("dashboard.metric.plusUnconfirmed", { count: c.due_soon_candidates }) : t("dashboard.metric.confirmedOnly")}
          icon={CalendarRange}
          tone="text-primary"
          to="/tasks?view=active&urgency=urgent&urgency=high&urgency=upcoming"
        />
        <MetricTile
          label={t("dashboard.metric.overdue")}
          value={c.overdue}
          sub={c.overdue_candidates ? t("dashboard.metric.plusUnconfirmed", { count: c.overdue_candidates }) : undefined}
          icon={TriangleAlert}
          tone="text-overdue"
          to="/tasks?view=active&urgency=overdue"
        />
        <MetricTile label={t("dashboard.metric.completed")} value={c.completed_7d} icon={CircleCheck} tone="text-success" to="/tasks?view=completed" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem] 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <section className="grid min-w-0 content-start gap-2">
          <div className="flex min-h-7 items-center justify-between gap-2">
            <h2 className="text-section font-semibold">{t("dashboard.attention")}</h2>
            {attentionTotal > shown ? (
              <Button variant="ghost" size="xs" asChild>
                <Link to="/tasks?view=active&sort=urgency">
                  {t("dashboard.attentionMore", { count: attentionTotal - shown })} <ArrowRight />
                </Link>
              </Button>
            ) : null}
          </div>
          {shown === 0 ? (
            <EmptyState compact icon={CircleCheckBig} title={t("dashboard.attentionEmpty")} description={t("dashboard.attentionEmptyHint")} />
          ) : (
            <AttentionList items={attention} />
          )}
          {c.due_soon === 0 && c.due_soon_candidates ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[13px] text-muted-foreground">
              {t("dashboard.noConfirmedDueSoon")}
              <Link to="/inbox?sort=due" className="inline-flex items-center gap-1 font-medium text-violet hover:underline">
                {t("dashboard.unconfirmedDueSoon", { count: c.due_soon_candidates })} <ArrowRight className="size-3.5" />
              </Link>
            </p>
          ) : null}
        </section>

        <aside className="grid min-w-0 content-start gap-6">
          <Suggestions data={data} />
          <SystemStatusCard />
        </aside>
      </div>
    </div>
  );
}
