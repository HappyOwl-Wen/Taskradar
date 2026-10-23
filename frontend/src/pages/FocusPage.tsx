import { ArrowLeft, CircleStop, Coffee, Maximize2, Minimize2, Pause, Play, Settings2, SkipForward, Target } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { NotifyHint } from "@/components/timers/NotifyHint";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/select";
import { ErrorState, LoadingRows, PageHeader } from "@/components/ui/states";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useFocusView } from "@/lib/focusView";
import { useSettings, useTasks } from "@/lib/queries";
import { formatClock, isActive, progressOf, useLiveTimers, useTimerAction } from "@/lib/timers";
import { TIMER_PHASES, type Settings, type TimerPhase } from "@/lib/types";
import { cn } from "@/lib/utils";
import "./focus.css";

const NO_TASK = "none";

function phaseMinutes(settings: Settings | undefined, phase: TimerPhase): number {
  const timers = settings?.timers;
  if (!timers) return phase === "focus" ? 25 : phase === "short_break" ? 5 : 15;
  return phase === "focus" ? timers.focus_minutes : phase === "short_break" ? timers.short_break_minutes : timers.long_break_minutes;
}

/** The time left inside a ring that fills as the phase runs: indigo while focusing, green on a break. */
function Ring({ progress, phase, children }: { progress: number; phase: TimerPhase; children: React.ReactNode }) {
  const radius = 108;
  const length = 2 * Math.PI * radius;
  return (
    <div className="focus-ring">
      <svg viewBox="0 0 240 240" className="focus-ring-track absolute inset-0 size-full -rotate-90" aria-hidden>
        <circle cx="120" cy="120" r={radius} fill="none" strokeWidth="10" className="stroke-muted" />
        <circle
          cx="120"
          cy="120"
          r={radius}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={length}
          strokeDashoffset={length * (1 - progress)}
          className={cn(
            "motion-safe:transition-[stroke-dashoffset] motion-safe:duration-1000 motion-safe:ease-linear",
            phase === "focus" ? "stroke-primary" : "stroke-success",
          )}
        />
      </svg>
      <div className="focus-ring-content relative text-center">{children}</div>
    </div>
  );
}

/** One dot per focus session of the set: filled for the ones done. */
function SetDots({ done, total }: { done: number; total: number }) {
  const { t } = useTranslation();
  return (
    <div className="focus-set-dots flex flex-wrap items-center justify-center gap-1.5" role="img" aria-label={t("focus.setProgress", { done, total })}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cn("size-2 rounded-full", i < done ? "bg-primary" : "bg-muted-foreground/30")} />
      ))}
    </div>
  );
}

export default function FocusPage() {
  const { t, i18n } = useTranslation();
  const { compact, toggleView } = useFocusView();
  const { data, error, isLoading, refetch, remaining } = useLiveTimers();
  const { data: settings } = useSettings();
  const { data: tasks } = useTasks({ status: ["in_progress", "confirmed"], sample: false, limit: 50 });
  const [chosen, setChosen] = useState<TimerPhase | null>(null);
  const [taskId, setTaskId] = useState(NO_TASK);
  const start = useTimerAction((phase: TimerPhase) => api.startPomodoro({ phase, task_id: taskId === NO_TASK ? undefined : taskId }), {
    onSuccess: () => setChosen(null),
  });
  const act = useTimerAction(({ id, action }: { id: number; action: "pause" | "resume" | "skip" | "cancel" }) => api.timerAction(id, action));

  if (isLoading) return <LoadingRows rows={4} />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const pomodoro = data.pomodoro;
  const current = isActive(pomodoro.current) ? pomodoro.current : null;
  const next = pomodoro.next ?? { phase: "focus" as const, cycle: 1, duration_seconds: phaseMinutes(settings, "focus") * 60 };
  const phase: TimerPhase = current?.phase ?? chosen ?? next.phase;
  const left = current ? remaining(current) : phaseMinutes(settings, phase) * 60;
  const clock = formatClock(left, i18n.language);
  const viewLabel = t(compact ? "focus.fullView" : "focus.compactView");
  const startLabel = t(`focus.start.${phase}`);
  const skipLabel = t(phase === "focus" ? "focus.skipToBreak" : "focus.skipToFocus");
  const every = pomodoro.long_break_every;
  // Focus sessions of the set done so far (a break has the number of the session it follows).
  const basis = current ? { phase: current.phase ?? "focus", cycle: current.cycle } : next;
  const done = Math.min(every, basis.phase === "focus" ? Math.max(0, basis.cycle - 1) : basis.cycle);
  const busy = start.isPending || act.isPending;
  const openTasks = [...(tasks?.items ?? [])].sort((a, b) => Number(b.status === "in_progress") - Number(a.status === "in_progress"));
  // While nothing runs: how the phase that just ended went.
  const last = pomodoro.last;
  const line =
    current || last?.status !== "finished" ? null : last.phase === "focus" ? t("focus.lastFocus", { cycle: last.cycle }) : t("focus.lastBreak");

  return (
    <div className="focus-page" data-compact={compact}>
      <div className="focus-view">
        <PageHeader
          className="focus-header"
          title={t("focus.title")}
          description={compact ? undefined : t("focus.description", {
            focus: phaseMinutes(settings, "focus"),
            short: phaseMinutes(settings, "short_break"),
            every,
            long: phaseMinutes(settings, "long_break"),
          })}
          actions={
            <>
              {compact ? (
                <Button variant="ghost" size="icon-sm" asChild>
                  <Link to="/" aria-label={t("focus.back")} title={t("focus.back")}>
                    <ArrowLeft />
                  </Link>
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={toggleView} aria-label={viewLabel} title={viewLabel}>
                {compact ? <Maximize2 /> : <Minimize2 />} <span className="focus-view-label">{viewLabel}</span>
              </Button>
              <Button variant="ghost" size="sm" asChild aria-label={t("focus.settings")} title={t("focus.settings")}>
                <Link to="/settings?section=timers">
                  <Settings2 /> <span className="focus-settings-label">{t("focus.settings")}</span>
                </Link>
              </Button>
            </>
          }
        />

        <div className="focus-workspace">
          <section aria-label={t("focus.timer")} className="focus-timer rounded-lg bg-subtle">
            <Tabs className="focus-phases" value={phase} onValueChange={(value) => setChosen(value as TimerPhase)}>
              <TabsList aria-label={t("focus.phase")} className="focus-phase-list">
                {TIMER_PHASES.map((p) => (
                  <TabsTrigger key={p} value={p} disabled={Boolean(current) && p !== phase}>
                    {t(`focus.phases.${p}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="focus-face-slot">
              <Ring progress={current ? progressOf(current, left) : 0} phase={phase}>
                <span className="focus-status font-medium text-muted-foreground">
                  {current?.status === "paused" ? t("focus.paused") : current ? t(`focus.running.${phase}`) : t("focus.ready")}
                </span>
                <span
                  className="focus-clock font-display font-semibold tracking-tight tabular-nums"
                  style={{ "--clock-characters": clock.length } as CSSProperties}
                  role="timer"
                  aria-live="off"
                >
                  {clock}
                </span>
                <SetDots done={done} total={every} />
                <span className="focus-set-label text-xs text-muted-foreground">{t("focus.setProgress", { done, total: every })}</span>
              </Ring>
            </div>

            {line ? (
              <p className="focus-secondary flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
                <Coffee className="size-4" aria-hidden /> {line}
              </p>
            ) : null}

            {current?.task_title && current.task_id ? (
              <p className="focus-secondary flex min-w-0 max-w-full items-center gap-1.5 text-sm">
                <Target className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="shrink-0 text-muted-foreground">{t("focus.workingOn")}</span>
                <Link to={`/tasks/${current.task_id}`} className="truncate font-medium hover:underline">
                  {current.task_title}
                </Link>
              </p>
            ) : null}

            <div className="focus-controls flex flex-wrap items-center justify-center gap-2">
              {!current ? (
                <Button size="lg" onClick={() => start.mutate(phase)} loading={start.isPending} disabled={busy} aria-label={startLabel} title={startLabel}>
                  <Play /> <span className="focus-control-label">{startLabel}</span>
                </Button>
              ) : (
                <>
                  {current.status === "running" ? (
                    <Button
                      size="lg" variant="outline" disabled={busy}
                      onClick={() => act.mutate({ id: current.id, action: "pause" })}
                      aria-label={t("focus.pause")} title={t("focus.pause")}
                    >
                      <Pause /> <span className="focus-control-label">{t("focus.pause")}</span>
                    </Button>
                  ) : (
                    <Button
                      size="lg" disabled={busy}
                      onClick={() => act.mutate({ id: current.id, action: "resume" })}
                      aria-label={t("focus.resume")} title={t("focus.resume")}
                    >
                      <Play /> <span className="focus-control-label">{t("focus.resume")}</span>
                    </Button>
                  )}
                  <Button
                    size="lg" variant="ghost" disabled={busy}
                    onClick={() => act.mutate({ id: current.id, action: "skip" })}
                    aria-label={skipLabel} title={skipLabel}
                  >
                    <SkipForward /> <span className="focus-control-label">{skipLabel}</span>
                  </Button>
                  <Button
                    size="lg" variant="ghost" disabled={busy}
                    onClick={() => act.mutate({ id: current.id, action: "cancel" })}
                    aria-label={t("focus.stop")} title={t("focus.stop")}
                  >
                    <CircleStop /> <span className="focus-control-label">{t("focus.stop")}</span>
                  </Button>
                </>
              )}
            </div>

            {!current && phase === "focus" && openTasks.length ? (
              <div className="focus-secondary focus-task-picker grid w-full gap-1.5">
                <label htmlFor="focus-task" className="text-[13px] font-medium text-muted-foreground">
                  {t("focus.taskLabel")}
                </label>
                <SimpleSelect
                  id="focus-task"
                  value={taskId}
                  onValueChange={setTaskId}
                  options={[{ value: NO_TASK, label: t("focus.noTask") }, ...openTasks.map((task) => ({ value: task.id, label: task.title }))]}
                />
              </div>
            ) : null}
          </section>

          <aside className="focus-aside grid h-fit gap-3">
            <section aria-labelledby="focus-today" className="grid gap-1 rounded-lg bg-subtle p-4">
              <h2 id="focus-today" className="text-sm font-semibold">
                {t("focus.today")}
              </h2>
              <p className="font-display text-2xl font-semibold tabular-nums">{t("focus.todaySessions", { count: pomodoro.today.focus_sessions })}</p>
              <p className="text-[13px] text-muted-foreground">{t("focus.todayMinutes", { count: pomodoro.today.focus_minutes })}</p>
            </section>
            <NotifyHint />
          </aside>
        </div>
      </div>
    </div>
  );
}
