import { ArrowRight, BellRing, CircleCheckBig, FlaskConical, FolderPlus, ListChecks, Mail, PenLine, RefreshCw, Upload, X, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { UploadButton } from "@/components/layout/TopBar";
import { SystemStatusCard } from "@/components/layout/SystemStatus";
import { LastImportCard } from "@/components/sources/LastImport";
import { conflictState, dateChangedState, unconfirmedState, type KeyState } from "@/components/tasks/keyStates";
import { TaskEditDialog } from "@/components/tasks/TaskEditDialog";
import { TaskListItem } from "@/components/tasks/TaskRow";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { formatDate, formatDue } from "@/lib/format";
import { expectSourceActivity, useAction, useDashboard, useDecisionQueue } from "@/lib/queries";
import { suggestionPayload } from "@/lib/review";
import type { AttentionReason, AttentionTask, Dashboard, Suggestion } from "@/lib/types";
import { cn } from "@/lib/utils";

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
const GUIDE_DISMISSED = "taskradar.firstStepsDismissed";

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

/** Waits for a decision (new, or with a pending suggestion): handled in the queue. */
const inQueue = (task: AttentionTask) => task.status === "candidate" || task.pending_suggestions > 0;
/** Groups that are about a date's reliability, not its closeness: a queued task there is decided in the queue. */
const QUEUE_GROUPS = new Set<AttentionReason>(["date_changed", "conflict"]);

function AttentionList({ items }: { items: AttentionTask[] }) {
  const { t } = useTranslation();
  const groups = GROUPS.map((g) => ({ group: g, tasks: items.filter((task) => groupOf(task) === g) })).filter((g) => g.tasks.length);
  return (
    <div className="grid gap-4">
      {groups.map(({ group, tasks }) => {
        // Listed once: what already waits in "things to decide" is pointed to here, not repeated.
        const queued = QUEUE_GROUPS.has(group) ? tasks.filter(inQueue) : [];
        const listed = tasks.filter((task) => !queued.includes(task));
        return (
          <section key={group} aria-label={t(`dashboard.group.${group}`)} className="grid gap-0.5">
            <h3 className={cn("flex items-center gap-2 border-b px-3 pb-1.5 text-xs font-semibold", GROUP_TONE[group])}>
              {t(`dashboard.group.${group}`)}
              <span className="font-normal text-muted-foreground tabular-nums">{tasks.length}</span>
            </h3>
            <ul className="grid gap-px">
              {listed.map((task) => (
                <li key={task.id}>
                  <TaskListItem
                    task={task}
                    to={task.status === "candidate" ? `/inbox?task=${task.id}` : `/tasks/${task.id}`}
                    states={attentionStates(task, t)}
                  />
                </li>
              ))}
              {queued.length ? (
                <li>
                  <Link
                    to={`/inbox?task=${queued[0].id}`}
                    className="flex min-h-10 items-center gap-2 rounded-md px-3 py-2 text-[13px] text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground active:bg-accent-strong"
                  >
                    <span className="min-w-0 flex-1">{t("dashboard.inQueue", { count: queued.length })}</span>
                    <ArrowRight className="size-4 shrink-0" aria-hidden />
                  </Link>
                </li>
              ) : null}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function shortDue(date: string | null | undefined, time: string | null | undefined, language: string): string | null {
  return date ? formatDue({ due_date: date, due_time: time ?? null }, language, new Date().getFullYear()) : null;
}

/** "and «other task» (date)" for a possible duplicate, so the decision can be judged from here. */
function DuplicateNote({ suggestion }: { suggestion: Suggestion }) {
  const { t, i18n } = useTranslation();
  // The other task's current title (the one saved with the suggestion if it is gone); never a bare dash.
  const other = suggestionPayload(suggestion).otherTitle ?? t("dashboard.suggestion.otherTask");
  const due = shortDue(suggestion.related_due_date, suggestion.related_due_time, i18n.language);
  return (
    <>
      {t("dashboard.suggestion.and")} {t("dashboard.suggestion.quoted", { title: other })}
      {due ? <span className={cn("ml-1.5 whitespace-nowrap tabular-nums", suggestion.deadlines_differ && "text-urgent")}>{due}</span> : null}
    </>
  );
}

/**
 * One entry for everything that waits for the user: "N things to decide", the first few with what is to
 * be decided about each, and one way in. New tasks, changed dates and possible duplicates are not
 * separate lists with their own numbers.
 */
function DecisionCard({ data, primary }: { data: Dashboard; primary: boolean }) {
  const { t } = useTranslation();
  const { items, isLoading } = useDecisionQueue();
  const real = items.filter((task) => !task.sample);
  const count = data.counts.needs_action ?? real.length;
  if (count === 0 && !isLoading) return null;
  const byTask = new Map(data.suggestions.map((s) => [s.task_id, s]));
  const top = real.slice(0, 3);
  return (
    <section className="grid gap-2">
      {/* The first thing to do today, so its way in is the page's main button. */}
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h2 className="text-section font-semibold">
          {t("dashboard.decide.title", { count })}
        </h2>
        {/* While the first steps are shown, their button is the main one; this one then steps back. */}
        <Button variant={primary ? "default" : "outline"} asChild>
          <Link to="/inbox">
            {t("dashboard.decide.start")} <ArrowRight />
          </Link>
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg bg-subtle">
        {isLoading && top.length === 0 ? <LoadingRows rows={2} className="p-3" /> : null}
        <ul className="grid gap-px p-1">
          {top.map((task) => {
            const suggestion = byTask.get(task.id);
            const disputed = suggestion && (suggestion.deadlines_differ || suggestion.kind === "update_due");
            return (
              <li key={task.id}>
                <TaskListItem
                  task={task}
                  to={`/inbox?task=${task.id}`}
                  states={disputed ? [conflictState(t)] : []}
                  note={suggestion?.kind === "possible_duplicate" ? <DuplicateNote suggestion={suggestion} /> : undefined}
                />
              </li>
            );
          })}
        </ul>
        <p className="border-t border-border/70 px-4 py-2.5 text-xs text-muted-foreground">
          {count > top.length ? t("dashboard.decide.more", { count: count - top.length }) : t("dashboard.decide.hint")}
        </p>
      </div>
    </section>
  );
}

function rememberGuide(dismissed: boolean) {
  try {
    if (dismissed) window.localStorage.setItem(GUIDE_DISMISSED, "1");
    else window.localStorage.removeItem(GUIDE_DISMISSED);
  } catch {
    // Storage may be unavailable (private window); the guide then simply shows again next time.
  }
}

function guideDismissed(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_DISMISSED) === "1";
  } catch {
    return false;
  }
}

/**
 * First steps: what TaskRadar does in three steps and one recommended way to start (import a file);
 * the other ways are one click further. Shown until the first task has been confirmed, and from
 * "Getting started" at any time.
 */
function FirstSteps({ candidates, onClose }: { candidates: number; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
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
        navigate("/inbox");
      },
    },
  );
  const steps: { icon: LucideIcon; title: string; hint: string }[] = [
    { icon: Upload, title: t("onboarding.step1"), hint: t("onboarding.step1Hint") },
    { icon: ListChecks, title: t("onboarding.step2"), hint: t("onboarding.step2Hint") },
    { icon: BellRing, title: t("onboarding.step3"), hint: t("onboarding.step3Hint") },
  ];
  const others: { icon: LucideIcon; label: string; action: ReactNode }[] = [
    {
      icon: Mail,
      label: t("onboarding.gmailHint"),
      action: (
        <Button variant="outline" size="xs" asChild>
          <Link to="/settings?section=gmail">{t("onboarding.gmail")}</Link>
        </Button>
      ),
    },
    {
      icon: FolderPlus,
      label: t("onboarding.folderHint"),
      action: (
        <Button variant="outline" size="xs" asChild>
          <Link to="/sources#folders">{t("onboarding.folder")}</Link>
        </Button>
      ),
    },
    {
      icon: FlaskConical,
      label: t("onboarding.demoHint"),
      action: (
        <Button variant="outline" size="xs" onClick={() => demo.mutate(undefined)} disabled={demo.isPending}>
          {demo.isPending ? <RefreshCw className="animate-spin" /> : null} {t("onboarding.demo")}
        </Button>
      ),
    },
  ];
  return (
    <section className="relative grid gap-5 rounded-lg bg-subtle p-5" aria-labelledby="first-steps">
      <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3 text-muted-foreground" onClick={onClose} aria-label={t("onboarding.close")}>
        <X />
      </Button>
      <div className="grid gap-1 pr-10">
        <h2 id="first-steps" className="text-section font-semibold">
          {t("onboarding.title")}
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{t("onboarding.description")}</p>
      </div>
      <ol className="grid gap-3 sm:grid-cols-3">
        {steps.map((s, i) => {
          const Icon = s.icon;
          const current = i === (candidates > 0 ? 1 : 0);
          return (
            <li key={s.title} className={cn("flex items-start gap-3 rounded-md bg-card p-3", current && "bg-selected ring-1 ring-primary/25")}>
              <span className={cn("grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold", current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                {i + 1}
              </span>
              <div className="grid min-w-0 gap-0.5">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Icon className="size-4 text-muted-foreground" aria-hidden /> {s.title}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">{s.hint}</p>
              </div>
            </li>
          );
        })}
      </ol>
      {candidates > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <Link to="/inbox">
              {t("onboarding.review", { count: candidates })} <ArrowRight />
            </Link>
          </Button>
          <p className="text-[13px] text-muted-foreground">{t("onboarding.reviewHint")}</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <UploadButton variant="default" compact={false} />
          <span className="text-[13px] text-muted-foreground">{t("onboarding.uploadHint")}</span>
          <Button variant="link" size="sm" className="px-0" onClick={() => setAddOpen(true)}>
            <PenLine /> {t("onboarding.orWrite")}
          </Button>
        </div>
      )}
      <details className="group/others">
        <summary className="w-fit cursor-pointer list-none text-sm font-medium text-muted-foreground outline-none select-none hover:text-foreground focus-visible:underline [&::-webkit-details-marker]:hidden">
          <ArrowRight className="mr-1 inline size-3.5 transition-transform group-open/others:rotate-90" aria-hidden />
          {t("onboarding.otherWays")}
        </summary>
        <ul className="mt-3 grid gap-2">
          {others.map((o) => {
            const Icon = o.icon;
            return (
              <li key={o.label} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md bg-card px-3 py-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 basis-48 text-[13px] leading-relaxed text-muted-foreground">{o.label}</span>
                {o.action}
              </li>
            );
          })}
        </ul>
      </details>
      <TaskEditDialog open={addOpen} onOpenChange={setAddOpen} />
    </section>
  );
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
  if (!parts.length) {
    // Nothing is due soon, but that is not the same as "nothing to do".
    const waiting = data.counts.needs_action ?? 0;
    if (waiting) return t("dashboard.summaryNothingDue", { count: waiting });
    const watch = data.attention?.length ?? 0;
    return watch ? t("dashboard.summaryNothingDueWatch", { count: watch }) : t("dashboard.summaryNone");
  }
  const unconfirmed = data.attention_unconfirmed ?? 0;
  return parts.join(t("dashboard.summaryJoin")) + (unconfirmed ? t("dashboard.summaryUnconfirmed", { count: unconfirmed }) : "");
}

export default function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { data, error, isLoading, refetch } = useDashboard();
  // null: follow the default (shown until the first confirmation); true/false: the user opened or closed it.
  const [guide, setGuide] = useState<boolean | null>(null);

  if (isLoading) return <LoadingRows rows={6} />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const counts = data.counts;
  const sampleOpen = counts.sample_open ?? 0;
  const attention = data.attention ?? [];
  const shown = attention.length;
  const attentionTotal = data.attention_total ?? shown;
  const everConfirmed = counts.ever_confirmed ?? counts.active + counts.completed_7d > 0;
  const showGuide = guide ?? (!everConfirmed && !guideDismissed());
  const closeGuide = () => {
    rememberGuide(true);
    setGuide(false);
  };

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-page font-semibold">{t("dashboard.greeting", { date: formatDate(data.today, i18n.language) })}</h1>
        <p className="text-sm text-muted-foreground">{summaryLine(data, t)}</p>
        {sampleOpen ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <FlaskConical className="size-3.5" aria-hidden />
            {t("sample.dashboardNote", { count: sampleOpen })}
            <Link to="/tasks?view=all&sample=1" className="font-medium text-foreground/80 hover:underline">
              {t("sample.showThem")}
            </Link>
          </p>
        ) : null}
      </header>

      {/* What the last import found stays here for a while, with the way to confirm it. */}
      <LastImportCard maxAgeMinutes={60} />
      {showGuide ? <FirstSteps candidates={counts.candidates} onClose={closeGuide} /> : null}

      {/* One element each, placed by the grid: on phones the decision comes right after the summary, on wide
          screens it stands beside the list with the system status under it. */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem] xl:grid-rows-[auto_1fr] 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="min-w-0 xl:col-start-2 xl:row-start-1">
          <DecisionCard data={data} primary={!showGuide} />
        </div>
        <section className="grid min-w-0 content-start gap-2 xl:col-start-1 xl:row-span-2 xl:row-start-1">
          <div className="flex min-h-8 items-center justify-between gap-2">
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
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-1 text-[13px] text-muted-foreground">
            <Link to="/tasks" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
              {t("dashboard.allOpen", { count: counts.active })} <ArrowRight className="size-3.5" />
            </Link>
            {counts.completed_7d ? (
              <Link to="/tasks?view=completed" className="hover:text-foreground hover:underline">
                {t("dashboard.completedWeek", { count: counts.completed_7d })}
              </Link>
            ) : null}
            {!showGuide ? (
              <button type="button" className="hover:text-foreground hover:underline" onClick={() => setGuide(true)}>
                {t("onboarding.reopen")}
              </button>
            ) : null}
          </p>
        </section>
        <div className="min-w-0 self-start xl:col-start-2 xl:row-start-2">
          <SystemStatusCard />
        </div>
      </div>
    </div>
  );
}
