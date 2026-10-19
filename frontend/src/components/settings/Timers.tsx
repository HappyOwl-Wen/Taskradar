import { useTranslation } from "react-i18next";
import { SwitchRow } from "@/components/ui/form";
import { useSystemStatus } from "@/lib/queries";
import { useSection } from "@/lib/settings";
import type { Settings } from "@/lib/types";
import { NotificationBanners } from "./Banners";
import { NumberField, SaveBar, SettingsCard } from "./common";

/** The Pomodoro timer's phases, what starts by itself, and the Windows notification when a timer ends. */
export function TimersSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: status } = useSystemStatus();
  const timers = useSection(settings, "timers");
  const v = timers.value;
  const supported = status?.desktop_notifications_supported ?? false;
  return (
    <SettingsCard
      id="timers"
      title={t("settings.sections.timers")}
      description={t("settings.timers.intro")}
      footer={<SaveBar dirty={timers.dirty} saving={timers.saving} onSave={timers.save} onReset={timers.reset} />}
    >
      <div className="grid gap-2">
        <p className="text-sm font-semibold">{t("settings.timers.pomodoro")}</p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <NumberField id="set-timer-focus" label={t("settings.timers.focusMinutes")} value={v.focus_minutes} min={1} max={180} onChange={(n) => timers.set("focus_minutes", n)} />
          <NumberField id="set-timer-short" label={t("settings.timers.shortBreakMinutes")} value={v.short_break_minutes} min={1} max={60} onChange={(n) => timers.set("short_break_minutes", n)} />
          <NumberField id="set-timer-long" label={t("settings.timers.longBreakMinutes")} value={v.long_break_minutes} min={1} max={120} onChange={(n) => timers.set("long_break_minutes", n)} />
          <NumberField id="set-timer-every" label={t("settings.timers.longBreakEvery")} value={v.long_break_every} min={2} max={12} onChange={(n) => timers.set("long_break_every", n)} />
        </div>
      </div>
      <div className="grid gap-3">
        <SwitchRow id="set-timer-auto-break" label={t("settings.timers.autoStartBreaks")} hint={t("settings.timers.autoStartBreaksHint")} checked={v.auto_start_breaks} onCheckedChange={(c) => timers.set("auto_start_breaks", c)} />
        <SwitchRow id="set-timer-auto-focus" label={t("settings.timers.autoStartFocus")} checked={v.auto_start_focus} onCheckedChange={(c) => timers.set("auto_start_focus", c)} />
      </div>
      <div className="grid gap-3 border-t pt-4">
        <SwitchRow
          id="set-timer-notify"
          label={t("settings.timers.notify")}
          hint={supported ? t("settings.timers.notifyHint") : t("timers.notifyUnsupported")}
          checked={v.notify}
          onCheckedChange={(c) => timers.set("notify", c)}
          disabled={!supported}
        />
        {v.notify ? <NotificationBanners /> : null}
      </div>
    </SettingsCard>
  );
}
