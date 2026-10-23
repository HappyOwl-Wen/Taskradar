import { Hourglass, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { NotifyHint } from "@/components/timers/NotifyHint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Tip } from "@/components/ui/menu";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/ui/states";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type TimerAction } from "@/lib/api";
import { formatDateTime, formatMinutes, formatTime, todayIn } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { formatClock, isActive, localMoment, progressOf, useLiveTimers, useTimerAction } from "@/lib/timers";
import type { TimerView } from "@/lib/types";
import { cn } from "@/lib/utils";

const PRESETS = [1, 3, 5, 10, 15, 25, 30, 45, 60];
const MAX_SECONDS = 7 * 24 * 3600;

type Mode = "duration" | "until";

function DurationInputs({
  hours,
  minutes,
  seconds,
  onChange,
}: {
  hours: string;
  minutes: string;
  seconds: string;
  onChange: (part: "hours" | "minutes" | "seconds", value: string) => void;
}) {
  const { t } = useTranslation();
  const parts = [
    { key: "hours" as const, value: hours, max: 168 },
    { key: "minutes" as const, value: minutes, max: 59 },
    { key: "seconds" as const, value: seconds, max: 59 },
  ];
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{t("countdown.duration")}</legend>
      <div className="grid grid-cols-3 gap-2">
        {parts.map((part) => (
          <label key={part.key} className="grid gap-1">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={part.max}
              value={part.value}
              placeholder="0"
              onChange={(e) => onChange(part.key, e.target.value)}
              className="text-center tabular-nums"
            />
            <span className="text-center text-xs text-muted-foreground">{t(`countdown.units.${part.key}`)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A new countdown: a duration (with quick presets) or a moment to count down to. */
function NewCountdown() {
  const { t, i18n } = useTranslation();
  const timeZone = useTimezone();
  const [mode, setMode] = useState<Mode>("duration");
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("10");
  const [seconds, setSeconds] = useState("");
  const [moment, setMoment] = useState(() => localMoment(timeZone, 60));
  const start = useTimerAction((body: { label: string; seconds?: number; until?: string }) => api.startCountdown(body), {
    onSuccess: () => setLabel(""),
  });

  const total = (Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60 + (Number(seconds) || 0);
  const valid = mode === "duration" ? total >= 1 && total <= MAX_SECONDS : Boolean(moment.date && moment.time);
  const setPart = (part: "hours" | "minutes" | "seconds", value: string) =>
    ({ hours: setHours, minutes: setMinutes, seconds: setSeconds })[part](value.replace(/[^0-9]/g, "").slice(0, 3));
  const preset = (m: number) => {
    setHours(m >= 60 ? String(Math.floor(m / 60)) : "");
    setMinutes(m % 60 ? String(m % 60) : m >= 60 ? "" : String(m));
    setSeconds("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    if (mode === "duration") start.mutate({ label, seconds: total });
    else start.mutate({ label, until: `${moment.date}T${moment.time}` });
  };

  return (
    <form onSubmit={submit} aria-labelledby="new-countdown" className="glass-card grid h-fit gap-4 p-5">
      <h2 id="new-countdown" className="text-section font-semibold">
        {t("countdown.new")}
      </h2>
      <Tabs
        value={mode}
        onValueChange={(value) => {
          setMode(value as Mode);
          if (value === "until") setMoment(localMoment(timeZone, 60));
        }}
      >
        <TabsList aria-label={t("countdown.mode")}>
          <TabsTrigger value="duration">{t("countdown.modes.duration")}</TabsTrigger>
          <TabsTrigger value="until">{t("countdown.modes.until")}</TabsTrigger>
        </TabsList>
      </Tabs>
      {mode === "duration" ? (
        <div className="grid gap-3">
          <DurationInputs hours={hours} minutes={minutes} seconds={seconds} onChange={setPart} />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("countdown.presets")}>
            {PRESETS.map((m) => (
              <Button key={m} type="button" variant="outline" size="xs" onClick={() => preset(m)}>
                {formatMinutes(m, i18n.language)}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
          <Field label={t("countdown.date")} htmlFor="countdown-date">
            <Input id="countdown-date" type="date" value={moment.date} onChange={(e) => setMoment((m) => ({ ...m, date: e.target.value }))} />
          </Field>
          <Field label={t("countdown.time")} htmlFor="countdown-time">
            <Input id="countdown-time" type="time" value={moment.time} onChange={(e) => setMoment((m) => ({ ...m, time: e.target.value }))} />
          </Field>
        </div>
      )}
      <Field label={t("countdown.label")} htmlFor="countdown-label">
        <Input id="countdown-label" value={label} maxLength={200} placeholder={t("countdown.labelPlaceholder")} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      {mode === "duration" && total > MAX_SECONDS ? (
        <p className="text-[13px] text-destructive" role="alert">
          {t("countdown.tooLong")}
        </p>
      ) : null}
      <Button type="submit" disabled={!valid} loading={start.isPending} className="w-full">
        <Play /> {t("countdown.start")}
      </Button>
    </form>
  );
}

function CountdownRow({ timer, remaining }: { timer: TimerView; remaining: number }) {
  const { t, i18n } = useTranslation();
  const timeZone = useTimezone();
  const act = useTimerAction((action: TimerAction) => api.timerAction(timer.id, action));
  const active = isActive(timer);
  const paused = timer.status === "paused";
  const lang = i18n.language;
  // A moment of today as a clock time, of another day with its date.
  const at = (iso: string) =>
    todayIn(timeZone, new Date(iso)) === todayIn(timeZone) ? formatTime(iso, lang, timeZone) : formatDateTime(iso, lang, timeZone);
  const when =
    timer.status === "running" && timer.ends_at
      ? t(timer.mode === "until" ? "countdown.endsAtUntil" : "countdown.endsAt", { time: at(timer.ends_at) })
      : paused
        ? t("countdown.pausedLeft")
        : t("countdown.endedAt", { time: timer.finished_at ? at(timer.finished_at) : "—" });
  const name = timer.label || t("countdown.unnamed");
  return (
    <li className={cn("glass-card grid gap-2 px-4 py-3", !active && "opacity-80")}>
      <div className="flex items-center gap-3">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            {paused ? <Badge tone="neutral">{t("countdown.paused")}</Badge> : null}
            {!active ? <Badge tone="success">{t("countdown.finished")}</Badge> : null}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {timer.mode === "duration" ? `${t("countdown.total", { time: formatClock(timer.duration_seconds, lang) })} · ` : null}
            {when}
          </p>
        </div>
        <span
          role="timer"
          aria-label={t("countdown.leftFor", { name, time: formatClock(remaining, lang) })}
          className={cn("font-display text-2xl font-semibold tabular-nums", !active && "text-muted-foreground", paused && "text-muted-foreground")}
        >
          {formatClock(remaining, lang)}
        </span>
        <div className="flex items-center">
          {timer.status === "running" && timer.mode === "duration" ? (
            <Tip content={t("countdown.pause")}>
              <Button variant="ghost" size="icon-sm" aria-label={t("countdown.pauseNamed", { name })} onClick={() => act.mutate("pause")} disabled={act.isPending}>
                <Pause />
              </Button>
            </Tip>
          ) : null}
          {paused ? (
            <Tip content={t("countdown.resume")}>
              <Button variant="ghost" size="icon-sm" aria-label={t("countdown.resumeNamed", { name })} onClick={() => act.mutate("resume")} disabled={act.isPending}>
                <Play />
              </Button>
            </Tip>
          ) : null}
          {!active && timer.mode === "duration" ? (
            <Tip content={t("countdown.restart")}>
              <Button variant="ghost" size="icon-sm" aria-label={t("countdown.restartNamed", { name })} onClick={() => act.mutate("restart")} disabled={act.isPending}>
                <RotateCcw />
              </Button>
            </Tip>
          ) : null}
          <Tip content={active ? t("countdown.cancel") : t("countdown.remove")}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t(active ? "countdown.cancelNamed" : "countdown.removeNamed", { name })}
              onClick={() => act.mutate("cancel")}
              disabled={act.isPending}
            >
              <X />
            </Button>
          </Tip>
        </div>
      </div>
      {active ? (
        <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className={cn("h-full rounded-full motion-safe:transition-[width] motion-safe:duration-1000 motion-safe:ease-linear", paused ? "bg-muted-foreground/50" : "bg-primary")}
            style={{ width: `${progressOf(timer, remaining) * 100}%` }}
          />
        </div>
      ) : null}
    </li>
  );
}

export default function CountdownsPage() {
  const { t } = useTranslation();
  const { data, error, isLoading, refetch, remaining } = useLiveTimers();
  const clear = useTimerAction(() => api.clearFinishedTimers());

  if (isLoading) return <LoadingRows rows={4} />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const running = data.countdowns.filter(isActive);
  const finished = data.countdowns.filter((c) => !isActive(c));

  return (
    <div className="grid gap-6">
      <PageHeader title={t("countdown.title")} description={t("countdown.description")} />
      <div className="grid gap-6 lg:grid-cols-[21rem_minmax(0,1fr)]">
        <div className="grid h-fit gap-3">
          <NewCountdown />
          <NotifyHint />
        </div>
        <div className="grid h-fit gap-5">
          {data.countdowns.length === 0 ? (
            <EmptyState icon={Hourglass} title={t("countdown.emptyTitle")} description={t("countdown.emptyHint")} className="rounded-lg border border-dashed" />
          ) : null}
          {running.length ? (
            <section aria-labelledby="countdowns-running" className="grid gap-2">
              <h2 id="countdowns-running" className="flex min-h-8 items-center gap-2 text-section font-semibold">
                {t("countdown.running")} <span className="text-sm font-normal text-muted-foreground tabular-nums">{running.length}</span>
              </h2>
              <ul className="grid gap-2">
                {running.map((timer) => (
                  <CountdownRow key={timer.id} timer={timer} remaining={remaining(timer)} />
                ))}
              </ul>
            </section>
          ) : null}
          {finished.length ? (
            <section aria-labelledby="countdowns-finished" className="grid gap-2">
              <div className="flex min-h-8 items-center justify-between gap-2">
                <h2 id="countdowns-finished" className="text-sm font-semibold text-muted-foreground">
                  {t("countdown.finishedList", { count: finished.length })}
                </h2>
                <Button variant="ghost" size="xs" onClick={() => clear.mutate(undefined)} disabled={clear.isPending}>
                  <Trash2 /> {t("countdown.clearFinished")}
                </Button>
              </div>
              <ul className="grid gap-2">
                {finished.map((timer) => (
                  <CountdownRow key={timer.id} timer={timer} remaining={0} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
