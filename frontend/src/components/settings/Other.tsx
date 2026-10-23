import { Archive, BellRing, Download, KeyRound, Power, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SystemStatusList } from "@/components/layout/SystemStatus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Checkbox, Input, Label, Switch, SwitchRow } from "@/components/ui/form";
import { api } from "@/lib/api";
import { useAction, useLegacyData, useSystemStatus } from "@/lib/queries";
import { useSection } from "@/lib/settings";
import type { Settings } from "@/lib/types";
import { NotificationBanners } from "./Banners";
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
        <NotificationBanners />
      </div>
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
      <div className="grid gap-2">
        <p className="text-sm font-semibold">{t("systemStatus.title")}</p>
        <SystemStatusList />
      </div>
      <dl className="grid gap-3 border-t pt-4">
        <InfoRow label={t("settings.system.version")}>{status.version}</InfoRow>
        <InfoRow label={t("settings.system.dataDir")}>
          <code className="font-mono text-xs">{status.data_dir}</code>
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

/**
 * What earlier versions left behind: the mails and files they imported (the tasks found in them stay) and sign-ins
 * that only removed features used. Shown only while something is there; everything is deleted on request only.
 */
function LegacyData() {
  const { t } = useTranslation();
  const { data } = useLegacyData();
  const [confirm, setConfirm] = useState(false);
  const removeImported = useAction(() => api.deleteImported(), {
    success: t("settings.data.legacy.importedDeleted"),
    onSuccess: () => setConfirm(false),
  });
  const removeCredential = useAction((name: "gmail" | "llm_api_key") => api.deleteLegacyCredential(name), {
    success: t("settings.data.legacy.credentialDeleted"),
  });
  if (!data) return null;
  const imported = data.messages + data.documents;
  if (imported === 0 && data.credentials.length === 0) return null;
  return (
    <div className="grid gap-3 rounded-lg bg-subtle p-4">
      <div className="grid gap-1">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Archive className="size-4 text-muted-foreground" aria-hidden /> {t("settings.data.legacy.title")}
        </p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t("settings.data.legacy.hint")}</p>
      </div>
      {imported ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1 basis-56 text-[13px]">
            {t("settings.data.legacy.imported", { messages: data.messages, documents: data.documents })}
          </span>
          <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
            <Trash2 /> {t("settings.data.legacy.deleteImported")}
          </Button>
        </div>
      ) : null}
      {data.credentials.map((name) => (
        <div key={name} className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex min-w-0 flex-1 basis-56 items-center gap-2 text-[13px]">
            <KeyRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> {t(`settings.data.legacy.credential.${name}`)}
          </span>
          <Button variant="outline" size="sm" onClick={() => removeCredential.mutate(name)} disabled={removeCredential.isPending}>
            <Trash2 /> {t("settings.data.legacy.deleteCredential")}
          </Button>
        </div>
      ))}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("settings.data.legacy.deleteImportedTitle")}
        description={t("settings.data.legacy.deleteImportedBody")}
        confirmLabel={t("settings.data.legacy.deleteImported")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={removeImported.isPending}
        onConfirm={() => removeImported.mutate(undefined)}
      />
    </div>
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
      localStorage.removeItem("taskradar.calendar.editor");
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
      <LegacyData />
      <div className="grid gap-2 rounded-lg bg-destructive/6 p-4">
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
