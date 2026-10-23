import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, VolumeX } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { BrowserAlarmSound } from "@/lib/alarmSound";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { qk } from "@/lib/queries";
import "./timer-alarm.css";

/** Global completion alarm: stays present on every page, including the compact timer view. */
export function TimerAlarm({ desktop }: { desktop: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [sound] = useState(() => new BrowserAlarmSound());
  const stopButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const { data } = useQuery({
    queryKey: qk.timerAlarm,
    queryFn: api.timerAlarm,
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
  const alarm = data?.alarm;
  const audible = Boolean(alarm?.audible && data?.sound_enabled);
  const dismiss = useMutation({
    mutationFn: async (id: number) => {
      await queryClient.cancelQueries({ queryKey: qk.timerAlarm });
      return api.dismissTimerAlarm(id);
    },
    onSuccess: async (state) => {
      await queryClient.cancelQueries({ queryKey: qk.timerAlarm });
      queryClient.setQueryData(qk.timerAlarm, state);
      void queryClient.invalidateQueries({ queryKey: qk.timers });
      void queryClient.invalidateQueries({ queryKey: qk.notifications });
    },
  });

  useEffect(() => {
    if (desktop) return;
    document.addEventListener("pointerdown", sound.arm, true);
    document.addEventListener("keydown", sound.arm, true);
    return () => {
      document.removeEventListener("pointerdown", sound.arm, true);
      document.removeEventListener("keydown", sound.arm, true);
      sound.dispose();
    };
  }, [desktop, sound]);

  useEffect(() => {
    if (!desktop && audible) sound.start();
    else sound.stop();
    return () => sound.stop();
  }, [desktop, alarm?.id, audible, sound]);

  useEffect(() => {
    if (!alarm?.id) return;
    void queryClient.invalidateQueries({ queryKey: qk.timers });
    void queryClient.invalidateQueries({ queryKey: qk.notifications });
  }, [alarm?.id, queryClient]);

  if (!alarm) return null;
  const stop = () => { if (!dismiss.isPending) dismiss.mutate(alarm.id); };

  return (
    <AlertDialog.Root open>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="motion-overlay fixed inset-0 z-[90] bg-black/45 dark:bg-black/60" />
        <AlertDialog.Content
          className="timer-alarm-dialog motion-dialog"
          onEscapeKeyDown={(event) => { event.preventDefault(); stop(); }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            stopButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = previousFocus.current?.isConnected ? previousFocus.current : document.getElementById("main");
            target?.focus();
          }}
        >
          <div className="timer-alarm-icon mx-auto grid size-12 shrink-0 place-items-center rounded-full bg-selected text-primary">
            <BellRing className="size-6 motion-safe:animate-pulse" aria-hidden />
          </div>
          <AlertDialog.Title className="timer-alarm-title shrink-0 font-display text-xl font-semibold">{alarm.title}</AlertDialog.Title>
          <AlertDialog.Description className="timer-alarm-description whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {alarm.body}
          </AlertDialog.Description>
          <p className="timer-alarm-hint text-xs text-muted-foreground">{t(audible ? "timerAlarm.ringing" : "timerAlarm.silent")}</p>
          {dismiss.error ? <p role="alert" className="text-xs text-destructive">{errorMessage(dismiss.error)}</p> : null}
          <Button ref={stopButton} className="timer-alarm-stop w-full shrink-0" size="lg" loading={dismiss.isPending} onClick={stop}>
            <VolumeX /> {t(audible ? "timerAlarm.stop" : "timerAlarm.dismiss")}
          </Button>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
