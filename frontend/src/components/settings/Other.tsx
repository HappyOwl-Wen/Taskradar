import { BellRing, Download, Power, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Checkbox, Input, Label, Switch, SwitchRow } from "@/components/ui/form";
import { api } from "@/lib/api";
import { useAction, useSystemStatus } from "@/lib/queries";
import { useSection } from "@/lib/settings";
import type { Settings } from "@/lib/types";
import { InfoRow, NumberField, SaveBar, SettingsCard } from "./common";

export function RemindersSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: status } = useSystemStatus();
  const reminders = useSection(settings, "reminders");
  const notifications = useSection(settings, "notifications");
  const test = useAction(() => api.testDesktopNotification(), { success: t("settings.reminders.testSent"), invalidate: false });
  const scan = useAction(() => api.scanReminders(), {
    success: (job) => t("settings.reminders.scanned", { count: Number(job.details?.created ?? 0) }),
  });
  const r = reminders.value;
  const dirty = reminders.dirty || notifications.dirty;
  const save = () => {
    if (reminders.dirty) reminders.save();
    if (notifications.dirty) notifications.save();
  };
  const supported = status?.desktop_notifications_supported ?? false;
  return (
    <SettingsCard
      id="reminders"
      title={t("settings.sections.reminders")}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={() => scan.mutate(undefined)} disabled={scan.isPending}>
            <RefreshCw /> {t("settings.reminders.scanNow")}
          </Button>
          <SaveBar
            dirty={dirty}
            saving={reminders.saving || notifications.saving}
            onSave={save}
            onReset={() => {
              reminders.reset();
              notifications.reset();
            }}
          />
        </>
      }
    >
      <div className="grid gap-2">
        <p className="text-sm font-semibold">{t("settings.reminders.thresholds")}</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField id="set-rem-urgent" label={t("settings.reminders.urgentHours")} value={r.urgent_hours} min={1} max={168} onChange={(n) => reminders.set("urgent_hours", n)} />
          <NumberField id="set-rem-high" label={t("settings.reminders.highDays")} value={r.high_days} min={1} max={30} onChange={(n) => reminders.set("high_days", n)} />
          <NumberField id="set-rem-upcoming" label={t("settings.reminders.upcomingDays")} value={r.upcoming_days} min={1} max={60} onChange={(n) => reminders.set("upcoming_days", n)} />
        </div>
      </div>
      <SwitchRow id="set-rem-upc" label={t("settings.reminders.notifyUpcoming")} checked={r.notify_upcoming} onCheckedChange={(c) => reminders.set("notify_upcoming", c)} />
      <SwitchRow id="set-rem-cand" label={t("settings.reminders.notifyCandidates")} checked={r.notify_candidates} onCheckedChange={(c) => reminders.set("notify_candidates", c)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField id="set-rem-repeat" label={t("settings.reminders.overdueRepeat")} value={r.overdue_repeat_hours} min={1} max={720} onChange={(n) => reminders.set("overdue_repeat_hours", n)} />
        <NumberField id="set-rem-scan" label={t("settings.reminders.scanInterval")} value={r.scan_interval_minutes} min={1} max={240} onChange={(n) => reminders.set("scan_interval_minutes", n)} />
      </div>
      <div className="grid gap-3 border-t pt-4">
        <SwitchRow
          id="set-desktop"
          label={t("settings.reminders.desktop")}
          hint={supported ? t("settings.reminders.desktopHint") : t("settings.reminders.desktopUnsupported")}
          checked={notifications.value.desktop_enabled}
          onCheckedChange={(c) => notifications.set("desktop_enabled", c)}
          disabled={!supported}
        />
        {supported ? (
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => test.mutate(undefined)}
            disabled={test.isPending || !settings.notifications.desktop_enabled || notifications.dirty}
          >
            <BellRing /> {t("settings.reminders.testDesktop")}
          </Button>
        ) : null}
      </div>
    </SettingsCard>
  );
}

export function PolicySection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const section = useSection(settings, "policy");
  const v = section.value;
  return (
    <SettingsCard
      id="policy"
      title={t("settings.sections.policy")}
      description={t("settings.policy.intro")}
      footer={<SaveBar dirty={section.dirty} saving={section.saving} onSave={section.save} onReset={section.reset} />}
    >
      <NumberField
        id="set-pol-review"
        label={t("settings.policy.reviewThreshold")}
        value={v.review_confidence_threshold}
        min={0}
        max={1}
        step={0.05}
        onChange={(n) => section.set("review_confidence_threshold", n)}
      />
      <SwitchRow
        id="set-pol-autocomplete"
        label={t("settings.policy.autoComplete")}
        checked={v.auto_complete_on_explicit_confirmation}
        onCheckedChange={(c) => section.set("auto_complete_on_explicit_confirmation", c)}
      />
      {v.auto_complete_on_explicit_confirmation ? (
        <NumberField
          id="set-pol-min"
          label={t("settings.policy.autoCompleteMin")}
          value={v.auto_complete_min_confidence}
          min={0.5}
          max={1}
          step={0.05}
          onChange={(n) => section.set("auto_complete_min_confidence", n)}
        />
      ) : null}
      <SwitchRow
        id="set-pol-deadline"
        label={t("settings.policy.autoDeadline")}
        checked={v.auto_apply_explicit_deadline_changes}
        onCheckedChange={(c) => section.set("auto_apply_explicit_deadline_changes", c)}
      />
    </SettingsCard>
  );
}

export function SystemSection() {
  const { t } = useTranslation();
  const { data: status } = useSystemStatus();
  const [pending, setPending] = useState<boolean | null>(null);
  const autostart = useAction((enabled: boolean) => api.setAutostart(enabled), {
    success: (r) => (r.enabled ? t("settings.system.autostartOn") : t("settings.system.autostartOff")),
    onSuccess: () => setPending(null),
  });
  if (!status) return null;
  return (
    <SettingsCard id="system" title={t("settings.sections.system")}>
      <dl className="grid gap-3">
        <InfoRow label={t("settings.system.version")}>{status.version}</InfoRow>
        <InfoRow label={t("settings.system.dataDir")}>
          <code className="font-mono text-xs">{status.data_dir}</code>
        </InfoRow>
        <InfoRow label={t("settings.system.ocr")}>
          {status.ocr.available ? (
            <span className="text-success">
              {t("settings.system.ocrAvailable", { version: status.ocr.version ?? status.ocr.engine, languages: status.ocr.languages.join(", ") })}
            </span>
          ) : (
            <span className="text-high">{t(status.packaged ? "settings.system.ocrMissingPackaged" : "settings.system.ocrMissing")}</span>
          )}
        </InfoRow>
        <InfoRow label={t("settings.system.secretStore")}>
          <Badge tone={status.secret_store.available ? "success" : "destructive"}>{status.secret_store.backend}</Badge>
        </InfoRow>
        <InfoRow label={t("settings.system.scheduler")}>
          {status.scheduler.running ? t("settings.system.schedulerRunning", { count: status.scheduler.jobs.length }) : t("settings.system.schedulerStopped")}
        </InfoRow>
      </dl>
      <div className="flex items-start justify-between gap-4 border-t pt-4">
        <div className="grid gap-1">
          <Label htmlFor="set-autostart" className="flex items-center gap-2">
            <Power className="size-4 text-muted-foreground" /> {t("settings.system.autostart")}
          </Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {status.autostart.supported ? t("settings.system.autostartHint") : t("settings.system.autostartUnsupported")}
          </p>
        </div>
        <Switch
          id="set-autostart"
          checked={status.autostart.enabled}
          disabled={!status.autostart.supported || autostart.isPending}
          onCheckedChange={(c) => setPending(c)}
        />
      </div>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={t("settings.system.autostartConfirmTitle")}
        description={pending ? t(status.packaged ? "settings.system.autostartEnableBodyPackaged" : "settings.system.autostartEnableBody") : t("settings.system.autostartDisableBody")}
        confirmLabel={t("common.confirm")}
        cancelLabel={t("common.cancel")}
        pending={autostart.isPending}
        onConfirm={() => pending !== null && autostart.mutate(pending)}
      />
    </SettingsCard>
  );
}

export function DataSection() {
  const { t } = useTranslation();
  const [withContent, setWithContent] = useState(false);
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const deleteAll = useAction(() => api.deleteAll(), {
    success: t("settings.data.deletedAll"),
    onSuccess: () => {
      setOpen(false);
      setPhrase("");
    },
  });
  return (
    <SettingsCard id="data" title={t("settings.sections.data")}>
      <div className="grid gap-2">
        <p className="text-sm font-semibold">{t("settings.data.export")}</p>
        <p className="text-[13px] text-muted-foreground">{t("settings.data.exportHint")}</p>
        <Label className="font-normal">
          <Checkbox checked={withContent} onCheckedChange={(c) => setWithContent(c === true)} />
          {t("settings.data.exportWithContent")}
        </Label>
        <Button variant="outline" size="sm" className="w-fit" asChild>
          <a href={api.exportUrl(withContent)} download>
            <Download /> {t("settings.data.download")}
          </a>
        </Button>
      </div>
      <div className="grid gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <p className="text-sm font-semibold text-destructive">{t("settings.data.deleteAll")}</p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t("settings.data.deleteAllHint")}</p>
        <Button variant="destructive" size="sm" className="w-fit" onClick={() => setOpen(true)}>
          <Trash2 /> {t("settings.data.deleteAll")}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setPhrase("");
        }}
        title={t("settings.data.deleteAllTitle")}
        description={t("settings.data.deleteAllBody")}
        confirmLabel={t("settings.data.deleteAllConfirm")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={deleteAll.isPending}
        confirmDisabled={phrase !== "DELETE"}
        onConfirm={() => deleteAll.mutate(undefined)}
      >
        <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="DELETE" aria-label="DELETE" className="font-mono" autoFocus />
      </ConfirmDialog>
    </SettingsCard>
  );
}
