import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";
import { qk, refreshTasks, useAction } from "./queries";
import type { TimersOverview, TimerView } from "./types";

export const isRunning = (timer: TimerView | null | undefined): timer is TimerView & { status: "running" } =>
  timer?.status === "running";
/** Running or paused: it still has time left. */
export const isActive = (timer: TimerView | null | undefined): timer is TimerView & { status: "running" | "paused" } =>
  timer?.status === "running" || timer?.status === "paused";

function runningTimers(data: TimersOverview | undefined): TimerView[] {
  if (!data) return [];
  return [data.pomodoro.current, ...data.countdowns].filter(isRunning);
}

/**
 * The timers as the server runs them. While one runs they are read again every 15 seconds (a phase may have started
 * by itself), otherwise every minute.
 */
export function useTimers() {
  return useQuery({
    queryKey: qk.timers,
    queryFn: api.timers,
    refetchInterval: (query) => (runningTimers(query.state.data).length ? 15_000 : 60_000),
  });
}

/** The current time, updated every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * The timers with their time left counting down every second (from what the server said when it was asked, so the
 * page never drifts from the server's clock). When a timer should have ended, the server is asked again: it ends
 * the timer (with its notification) and maybe starts the next Pomodoro phase.
 */
export function useLiveTimers() {
  const query = useTimers();
  const { data, dataUpdatedAt, refetch } = query;
  const running = runningTimers(data);
  const now = useNow(running.length > 0);
  const elapsed = Math.max(0, now - dataUpdatedAt) / 1000;
  const remaining = (timer: TimerView): number =>
    timer.status === "running" ? Math.max(0, Math.ceil(timer.remaining_seconds - elapsed)) : timer.remaining_seconds;
  const ended = running.some((timer) => remaining(timer) <= 0);
  useEffect(() => {
    if (!ended) return;
    const id = window.setTimeout(() => void refetch(), 400);
    return () => window.clearTimeout(id);
  }, [ended, refetch, dataUpdatedAt]);
  return { ...query, remaining };
}

/** How far a timer has run (0..1). */
export function progressOf(timer: TimerView, remaining: number): number {
  if (timer.duration_seconds <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - remaining / timer.duration_seconds));
}

/**
 * A change to the timers (start, pause, …): the server answers with all timers, which replace the shown ones at once.
 * After an error (the timer may have ended meanwhile) they are read again. A focus session on a to-do that starts or
 * resumes moves the to-do to "进行中", so the tasks are read again then.
 */
export function useTimerAction<TVars>(fn: (vars: TVars) => Promise<TimersOverview>, options: { onSuccess?: (data: TimersOverview) => void } = {}) {
  const queryClient = useQueryClient();
  return useAction(
    async (vars: TVars) => {
      try {
        return await fn(vars);
      } catch (error) {
        void queryClient.invalidateQueries({ queryKey: qk.timers });
        throw error;
      }
    },
    {
      invalidate: false,
      onSuccess: (data) => {
        queryClient.setQueryData(qk.timers, data);
        const current = data.pomodoro.current;
        if (isRunning(current) && current.phase === "focus" && current.task_id) void refreshTasks(queryClient);
        options.onSuccess?.(data);
      },
    },
  );
}

/** "25:00", "1:05:09", or with days for long countdowns ("2 天 03:04:05", "2d 03:04:05"). */
export function formatClock(seconds: number, lang: string): string {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}${lang === "en" ? "d" : " 天"} ${two(hours)}:${two(minutes)}:${two(secs)}`;
  if (hours > 0) return `${hours}:${two(minutes)}:${two(secs)}`;
  return `${two(minutes)}:${two(secs)}`;
}

/** Date ("YYYY-MM-DD") and time ("HH:MM") in the given time zone, `minutes` from now (rounded up to 5 minutes). */
export function localMoment(timeZone: string, minutes: number, now: Date = new Date()): { date: string; time: string } {
  const at = new Date(Math.ceil((now.getTime() + minutes * 60_000) / 300_000) * 300_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
