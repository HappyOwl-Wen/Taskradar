import {
  ArrowRight,
  CalendarRange,
  CalendarX2,
  CircleCheck,
  CircleCheckBig,
  FlaskConical,
  FolderPlus,
  Inbox,
  Mail,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { UploadButton } from "@/components/layout/TopBar";
import { JobItem } from "@/components/sources/JobItem";
import { TaskListItem } from "@/components/tasks/TaskRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { expectSourceActivity, useAction, useDashboard } from "@/lib/queries";
import type { AttentionTask, Dashboard } from "@/lib/types";
import { cn } from "@/lib/utils";

function MetricTile({ label, value, sub, icon: Icon, tone, to }: { label: string; value: number; sub?: string; icon: LucideIcon; tone: string; to: string }) {
  return (
    <Link
      to={to}
      className="group grid gap-1 rounded-lg border bg-card px-4 py-3 transition-colors outline-none hover:border-ring/40 hover:bg-accent/30 focus-visible:ring-[3px] focus-visible:ring-ring/40"
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

/** Why a task is in the attention list. Unconfirmed tasks are always marked as such, whatever the reason. */
function AttentionBadge({ task }: { task: AttentionTask }) {
  const { t } = useTranslation();
  const unconfirmed = task.status === "candidate" ? <Badge tone="violet">{t("dashboard.reason.unconfirmed")}</Badge> : null;
  if (task.attention === "overdue")
    return (
      <>
        {unconfirmed}
        <Badge tone="overdue">{t("dashboard.reason.overdue")}</Badge>
      </>
    );
  if (task.attention === "conflict")
    return (
      <>
        {unconfirmed}
        <Badge tone="high">
          <CalendarX2 /> {t("dashboard.reason.conflict")}
        </Badge>
      </>
    );
  return unconfirmed; // due soon: the deadline itself says how soon
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
  const steps: { icon: LucideIcon; title: string; hint: string; action: React.ReactNode }[] = [
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
        <h2 className="text-base font-semibold">{t("onboarding.title")}</h2>
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

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{children}</h2>
      {aside}
    </div>
  );
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation();
  const timezone = useTimezone();
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
  };
  const attention = data.attention ?? [];
  const parts = [
    c.overdue ? t("dashboard.summaryOverdue", { count: c.overdue }) : null,
    c.due_soon ? t("dashboard.summaryDueSoon", { count: c.due_soon }) : null,
    c.needs_action ? t("dashboard.summaryNeedsAction", { count: c.needs_action }) : null,
  ].filter(Boolean);
  const summary = parts.length ? parts.join(t("dashboard.summaryJoin")) : t("dashboard.summaryNone");
  const shown = attention.length;
  const attentionTotal = data.attention_total ?? shown;

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("dashboard.greeting", { date: formatDate(data.today, i18n.language) })}</h1>
        <p className="text-sm text-muted-foreground">{summary}</p>
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
          tone="text-upcoming"
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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="grid min-w-0 content-start gap-2">
          <SectionTitle
            aside={
              attentionTotal > shown ? (
                <Button variant="ghost" size="xs" asChild>
                  <Link to="/tasks?view=active&sort=urgency">
                    {t("dashboard.attentionMore", { count: attentionTotal - shown })} <ArrowRight />
                  </Link>
                </Button>
              ) : null
            }
          >
            {t("dashboard.attention")}
          </SectionTitle>
          {shown === 0 ? (
            <EmptyState compact icon={CircleCheckBig} title={t("dashboard.attentionEmpty")} description={t("dashboard.attentionEmptyHint")} />
          ) : (
            <ul className="grid gap-0.5 rounded-lg border bg-card p-1">
              {attention.map((task) => (
                <li key={task.id}>
                  <TaskListItem
                    task={task}
                    to={task.status === "candidate" ? `/inbox?task=${task.id}` : `/tasks/${task.id}`}
                    badge={<AttentionBadge task={task} />}
                    // A conflict badge already names the problem; repeating it as an issue adds noise.
                    hideIssues={task.attention === "conflict"}
                  />
                </li>
              ))}
            </ul>
          )}
          {c.due_soon === 0 ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[13px] text-muted-foreground">
              {t("dashboard.noConfirmedDueSoon")}
              {c.due_soon_candidates ? (
                <Link to="/inbox?sort=due" className="inline-flex items-center gap-1 font-medium text-violet hover:underline">
                  {t("dashboard.unconfirmedDueSoon", { count: c.due_soon_candidates })} <ArrowRight className="size-3.5" />
                </Link>
              ) : null}
            </p>
          ) : null}
        </section>

        <aside className="grid min-w-0 content-start gap-6">
          {data.suggestions.length ? (
            <section className="grid gap-2">
              <SectionTitle
                aside={
                  <Button variant="ghost" size="xs" asChild>
                    <Link to="/inbox?tab=suggestions">
                      {t("common.viewAll")} <ArrowRight />
                    </Link>
                  </Button>
                }
              >
                {t("dashboard.suggestions")} <span className="font-normal text-muted-foreground tabular-nums">({c.pending_suggestions})</span>
              </SectionTitle>
              <ul className="grid divide-y rounded-lg border bg-card">
                {data.suggestions.slice(0, 3).map((s) => (
                  <li key={s.id}>
                    <Link to="/inbox?tab=suggestions" className="grid gap-0.5 px-3 py-2 outline-none hover:bg-accent/40 focus-visible:bg-accent/40">
                      <span className="text-[13px] font-medium">{t(`suggestionCard.${s.kind}.title`)}</span>
                      <span className="truncate text-xs text-muted-foreground" title={s.task_title}>
                        {s.task_title}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="grid gap-2">
            <SectionTitle
              aside={
                <Button variant="ghost" size="xs" asChild>
                  <Link to="/insights">
                    {t("dashboard.allActivity")} <ArrowRight />
                  </Link>
                </Button>
              }
            >
              {t("dashboard.recentJobs")}
            </SectionTitle>
            {data.recent_jobs.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[13px] text-muted-foreground">{t("dashboard.recentJobsEmpty")}</p>
            ) : (
              <div className="grid divide-y rounded-lg border bg-card px-3">
                {data.recent_jobs.slice(0, 4).map((job) => (
                  <JobItem key={job.id} job={job} timezone={timezone} compact />
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
