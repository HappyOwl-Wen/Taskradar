import {
  CalendarRange,
  Check,
  CircleCheck,
  Crosshair,
  FlaskConical,
  FolderPlus,
  Inbox,
  Lightbulb,
  Mail,
  PartyPopper,
  RefreshCw,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { UploadButton } from "@/components/layout/TopBar";
import { JobItem } from "@/components/sources/JobItem";
import { SuggestionCard } from "@/components/tasks/SuggestionCard";
import { TaskRow } from "@/components/tasks/TaskRow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tip } from "@/components/ui/menu";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/ui/states";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { useAction, useDashboard } from "@/lib/queries";
import type { Dashboard, TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  to,
}: {
  label: string;
  value: number;
  sub?: string;
  icon: LucideIcon;
  tone: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="group grid gap-2 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:border-ring/40 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
    >
      <div className="flex items-center justify-between text-[13px] text-muted-foreground">
        <span>{label}</span>
        <Icon className={cn("size-4", tone)} />
      </div>
      <div className="flex items-baseline gap-2">
        <span className={cn("text-2xl font-semibold tabular-nums", value > 0 && tone)}>{value}</span>
        {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
      </div>
    </Link>
  );
}

function CandidateActions({ task }: { task: TaskSummary }) {
  const { t } = useTranslation();
  const confirm = useAction(() => api.setStatus(task.id, "confirmed"), { success: t("inbox.confirmed", { count: 1 }) });
  const dismiss = useAction(() => api.setStatus(task.id, "dismissed"), { success: t("inbox.dismissed", { count: 1 }) });
  const busy = confirm.isPending || dismiss.isPending;
  return (
    <>
      <Tip content={t("common.dismiss")}>
        <Button variant="ghost" size="icon-xs" disabled={busy} onClick={() => dismiss.mutate(undefined)} aria-label={t("common.dismiss")}>
          <X />
        </Button>
      </Tip>
      <Tip content={t("statusAction.confirm")}>
        <Button variant="outline" size="icon-xs" disabled={busy} onClick={() => confirm.mutate(undefined)} aria-label={t("statusAction.confirm")}>
          <Check />
        </Button>
      </Tip>
    </>
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
    { success: t("onboarding.demoCreated"), onSuccess: () => navigate("/sources") },
  );
  const steps: { icon: LucideIcon; title: string; hint: string; action: React.ReactNode }[] = [
    { icon: FlaskConical, title: t("onboarding.demo"), hint: t("onboarding.demoHint"), action: (
      <Button size="sm" onClick={() => demo.mutate(undefined)} disabled={demo.isPending}>
        {demo.isPending ? <RefreshCw className="animate-spin" /> : <FlaskConical />} {t("onboarding.demo")}
      </Button>
    ) },
    { icon: Mail, title: t("onboarding.gmail"), hint: t("onboarding.gmailHint"), action: (
      <Button variant="outline" size="sm" asChild>
        <Link to="/settings#gmail">
          <Mail /> {t("onboarding.gmail")}
        </Link>
      </Button>
    ) },
    { icon: FolderPlus, title: t("onboarding.folder"), hint: t("onboarding.folderHint"), action: (
      <Button variant="outline" size="sm" asChild>
        <Link to="/sources#folders">
          <FolderPlus /> {t("onboarding.folder")}
        </Link>
      </Button>
    ) },
  ];
  return (
    <Card className="overflow-hidden">
      <div className="grid gap-5 bg-gradient-to-br from-primary/8 via-transparent to-violet/8 p-6">
        <div className="grid gap-1.5">
          <h2 className="text-lg font-semibold">{t("onboarding.title")}</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{t("onboarding.description")}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <div className="grid content-between gap-3 rounded-lg border bg-card p-4">
            <div className="grid gap-1">
              <p className="text-sm font-medium">{t("onboarding.upload")}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{t("onboarding.uploadHint")}</p>
            </div>
            <UploadButton variant="outline" />
          </div>
          {steps.map((s) => (
            <div key={s.title} className="grid content-between gap-3 rounded-lg border bg-card p-4">
              <div className="grid gap-1">
                <p className="text-sm font-medium">{s.title}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{s.hint}</p>
              </div>
              <div>{s.action}</div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function isEmptyWorkspace(d: Dashboard): boolean {
  return d.counts.active + d.counts.candidates + d.counts.completed_7d === 0 && d.recent_jobs.length === 0;
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation();
  const timezone = useTimezone();
  const { data, error, isLoading, refetch } = useDashboard();

  if (isLoading) return <LoadingRows rows={6} />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const c = data.counts;
  const summary =
    c.overdue + c.today_focus + c.candidates === 0
      ? t("dashboard.summaryNone")
      : t("dashboard.summary", { overdue: c.overdue, focus: c.today_focus, candidates: c.candidates });

  return (
    <div className="grid gap-6">
      <PageHeader title={t("dashboard.greeting", { date: formatDate(data.today, i18n.language) })} description={summary} />

      {isEmptyWorkspace(data) ? <Onboarding /> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label={t("dashboard.stats.overdue")} value={c.overdue} icon={TriangleAlert} tone="text-overdue" to="/tasks?view=active&urgency=overdue" />
        <StatCard label={t("dashboard.stats.today")} value={c.today_focus} icon={Crosshair} tone="text-urgent" to="/tasks?view=active&sort=urgency" />
        <StatCard label={t("dashboard.stats.upcoming")} value={c.upcoming_7d} icon={CalendarRange} tone="text-upcoming" to="/tasks?view=active&urgency=urgent&urgency=high&urgency=upcoming" />
        <StatCard
          label={t("dashboard.stats.candidates")}
          value={c.candidates}
          sub={c.needs_review ? t("dashboard.stats.needsReview", { count: c.needs_review }) : undefined}
          icon={Inbox}
          tone="text-violet"
          to="/inbox"
        />
        <StatCard label={t("dashboard.stats.suggestions")} value={c.pending_suggestions} icon={Lightbulb} tone="text-violet" to="/inbox?tab=suggestions" />
        <StatCard label={t("dashboard.stats.completed")} value={c.completed_7d} icon={CircleCheck} tone="text-success" to="/tasks?view=completed" />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="grid min-w-0 content-start gap-6 xl:col-span-2">
          <section className="grid gap-3">
            <h2 className="text-base font-semibold">{t("dashboard.focus")}</h2>
            {data.today_focus.length === 0 ? (
              <EmptyState icon={PartyPopper} title={t("dashboard.focusEmpty")} description={t("dashboard.focusEmptyHint")} compact />
            ) : (
              <div className="grid gap-2">
                {data.today_focus.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            )}
          </section>
          <section className="grid gap-3">
            <h2 className="text-base font-semibold">{t("dashboard.upcoming")}</h2>
            {data.upcoming.length === 0 ? (
              <EmptyState icon={CalendarRange} title={t("dashboard.upcomingEmpty")} compact />
            ) : (
              <div className="grid gap-2">
                {data.upcoming.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader>
              <div className="grid gap-0.5">
                <CardTitle>{t("dashboard.candidates")}</CardTitle>
                <CardDescription>{t("dashboard.stats.candidates")} · {c.candidates}</CardDescription>
              </div>
              <Button variant="ghost" size="xs" asChild>
                <Link to="/inbox">{t("dashboard.openInbox")}</Link>
              </Button>
            </CardHeader>
            <CardContent className="grid gap-2">
              {data.candidates.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t("dashboard.candidatesEmpty")}</p>
              ) : (
                data.candidates.slice(0, 5).map((task) => <TaskRow key={task.id} task={task} actions={<CandidateActions task={task} />} />)
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("dashboard.suggestions")}</CardTitle>
              {data.suggestions.length > 2 ? (
                <Button variant="ghost" size="xs" asChild>
                  <Link to="/inbox?tab=suggestions">{t("common.viewAll")}</Link>
                </Button>
              ) : null}
            </CardHeader>
            <CardContent className="grid gap-2">
              {data.suggestions.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t("dashboard.suggestionsEmpty")}</p>
              ) : (
                data.suggestions.slice(0, 2).map((s) => <SuggestionCard key={s.id} suggestion={s} />)
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("dashboard.recentJobs")}</CardTitle>
              <Button variant="ghost" size="xs" asChild>
                <Link to="/sources">{t("nav.sources")}</Link>
              </Button>
            </CardHeader>
            <CardContent className="grid divide-y">
              {data.recent_jobs.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t("dashboard.recentJobsEmpty")}</p>
              ) : (
                data.recent_jobs.slice(0, 5).map((job) => <JobItem key={job.id} job={job} timezone={timezone} compact />)
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
