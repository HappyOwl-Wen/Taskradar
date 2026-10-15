import { CalendarCheck, FileJson, Link2, Mail, Unplug } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Label, SwitchRow } from "@/components/ui/form";
import { api } from "@/lib/api";
import { useAction, useGoogle } from "@/lib/queries";
import { useSection } from "@/lib/settings";
import { CATEGORIES, type Settings } from "@/lib/types";
import { InfoRow, NumberField, SaveBar, SettingsCard } from "./common";

function useConnect(service: "gmail" | "calendar") {
  // The consent page is Google's own; after approval Google redirects to the local callback,
  // which stores the token in the Windows Credential Manager and returns to the settings page.
  return useAction(() => api.connectGoogle(service), {
    invalidate: false,
    onSuccess: ({ auth_url }) => window.location.assign(auth_url),
  });
}

function Disconnect({ service, label }: { service: "gmail" | "calendar"; label: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const disconnect = useAction(() => api.disconnectGoogle(service), {
    success: service === "gmail" ? t("settings.gmail.disconnected") : t("settings.calendar.disconnected"),
    onSuccess: () => setOpen(false),
  });
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Unplug /> {label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={label}
        description={service === "gmail" ? t("settings.gmail.disconnect") : t("settings.calendar.disconnect")}
        confirmLabel={label}
        cancelLabel={t("common.cancel")}
        destructive
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate(undefined)}
      />
    </>
  );
}

function ClientConfig() {
  const { t } = useTranslation();
  const { data: google } = useGoogle();
  const input = useRef<HTMLInputElement>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const upload = useAction((file: File) => api.uploadClientConfig(file), { success: t("settings.gmail.clientSaved") });
  const remove = useAction(() => api.deleteClientConfig(), { onSuccess: () => setRemoveOpen(false) });
  const client = google?.client;
  return (
    <div className="grid gap-2 rounded-lg border p-4">
      <p className="text-sm font-semibold">{t("settings.gmail.clientTitle")}</p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t("settings.gmail.clientHint")}</p>
      <p className="text-sm">
        {client?.configured ? (
          <span className="text-success">{t("settings.gmail.clientConfigured", { hint: client.client_id_hint ?? "" })}</span>
        ) : (
          <span className="text-muted-foreground">{t("settings.gmail.clientMissing")}</span>
        )}
      </p>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) upload.mutate(file);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => input.current?.click()} disabled={upload.isPending}>
          <FileJson /> {t("settings.gmail.uploadClient")}
        </Button>
        {client?.configured ? (
          <Button variant="ghost" size="sm" onClick={() => setRemoveOpen(true)}>
            {t("settings.gmail.removeClient")}
          </Button>
        ) : null}
      </div>
      {google ? (
        <dl className="mt-1 grid gap-2">
          <InfoRow label={t("settings.gmail.redirectUri")}>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{google.redirect_uri}</code>
          </InfoRow>
        </dl>
      ) : null}
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("settings.gmail.removeClient")}
        description={t("settings.gmail.clientHint")}
        confirmLabel={t("settings.gmail.removeClient")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </div>
  );
}

function Scopes({ scopes }: { scopes: string[] }) {
  const { t } = useTranslation();
  return (
    <InfoRow label={t("settings.gmail.scopes")}>
      <span className="flex flex-wrap gap-1.5">
        {scopes.map((s) => (
          <code key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {s.replace("https://www.googleapis.com/auth/", "")}
          </code>
        ))}
      </span>
    </InfoRow>
  );
}

export function GmailSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: google } = useGoogle();
  const section = useSection(settings, "gmail");
  const connect = useConnect("gmail");
  const v = section.value;
  const connected = Boolean(google?.gmail.connected);
  const account = google?.gmail.source?.account;
  return (
    <SettingsCard
      id="gmail"
      title={t("settings.sections.gmail")}
      footer={<SaveBar dirty={section.dirty} saving={section.saving} onSave={section.save} onReset={section.reset} />}
    >
      <ClientConfig />
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={connected ? "success" : "normal"}>
            <Mail /> {connected ? (account ? t("settings.gmail.connectedAs", { account }) : t("settings.gmail.connected")) : t("settings.gmail.notConnected")}
          </Badge>
          {google?.gmail.source?.status === "auth_required" ? <Badge tone="high">{t("sourceStatus.auth_required")}</Badge> : null}
        </div>
        {google ? (
          <dl className="grid gap-2">
            <Scopes scopes={google.gmail.scopes} />
          </dl>
        ) : null}
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t("settings.gmail.authHint")}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => connect.mutate(undefined)} disabled={!google?.client.configured || connect.isPending}>
            <Link2 /> {connected ? t("settings.gmail.reconnect") : t("settings.gmail.connect")}
          </Button>
          {connected ? <Disconnect service="gmail" label={t("settings.gmail.disconnect")} /> : null}
        </div>
      </div>
      <div className="grid gap-4 border-t pt-4">
        <SwitchRow id="set-gmail-auto" label={t("settings.gmail.autoSync")} checked={v.auto_sync} onCheckedChange={(c) => section.set("auto_sync", c)} />
        <SwitchRow
          id="set-gmail-att"
          label={t("settings.gmail.attachments")}
          checked={v.process_attachments}
          onCheckedChange={(c) => section.set("process_attachments", c)}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField id="set-gmail-interval" label={t("settings.gmail.interval")} value={v.sync_interval_minutes} min={5} max={1440} onChange={(n) => section.set("sync_interval_minutes", n)} />
          <NumberField id="set-gmail-lookback" label={t("settings.gmail.lookback")} value={v.lookback_days} min={1} max={365} onChange={(n) => section.set("lookback_days", n)} />
          <NumberField id="set-gmail-att-mb" label={t("settings.gmail.maxAttachment")} value={v.max_attachment_mb} min={1} max={25} onChange={(n) => section.set("max_attachment_mb", n)} />
        </div>
        <Field label={t("settings.gmail.queryExtra")} hint={t("settings.gmail.queryExtraHint")} htmlFor="set-gmail-query">
          <Input id="set-gmail-query" value={v.query_extra} onChange={(e) => section.set("query_extra", e.target.value)} className="max-w-md font-mono" />
        </Field>
      </div>
    </SettingsCard>
  );
}

export function CalendarSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: google } = useGoogle();
  const section = useSection(settings, "calendar");
  const connect = useConnect("calendar");
  const v = section.value;
  const connected = Boolean(google?.calendar.connected);
  return (
    <SettingsCard
      id="calendar"
      title={t("settings.sections.calendar")}
      description={t("settings.calendar.intro")}
      footer={<SaveBar dirty={section.dirty} saving={section.saving} onSave={section.save} onReset={section.reset} />}
    >
      <div className="grid gap-3">
        <Badge tone={connected ? "success" : "normal"}>
          <CalendarCheck />
          {connected ? t("settings.calendar.connected", { name: google?.calendar.calendar_name ?? v.calendar_name }) : t("settings.gmail.notConnected")}
        </Badge>
        {google ? (
          <dl className="grid gap-2">
            <Scopes scopes={google.calendar.scopes} />
          </dl>
        ) : null}
        {!google?.client.configured ? <p className="text-[13px] text-muted-foreground">{t("errors.client_not_configured")}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => connect.mutate(undefined)} disabled={!google?.client.configured || connect.isPending}>
            <Link2 /> {connected ? t("settings.gmail.reconnect") : t("settings.calendar.connect")}
          </Button>
          {connected ? <Disconnect service="calendar" label={t("settings.calendar.disconnect")} /> : null}
        </div>
      </div>
      <div className="grid gap-4 border-t pt-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("settings.calendar.calendarName")} htmlFor="set-cal-name">
            <Input id="set-cal-name" value={v.calendar_name} onChange={(e) => section.set("calendar_name", e.target.value)} />
          </Field>
          <NumberField
            id="set-cal-reminder"
            label={t("settings.calendar.reminderMinutes")}
            value={v.reminder_minutes}
            min={0}
            max={40320}
            step={15}
            onChange={(n) => section.set("reminder_minutes", n)}
          />
        </div>
        <SwitchRow
          id="set-cal-remove"
          label={t("settings.calendar.removeOnDismiss")}
          hint={t("settings.calendar.removeOnDismissHint")}
          checked={v.remove_on_dismiss}
          onCheckedChange={(c) => section.set("remove_on_dismiss", c)}
        />
        <SwitchRow
          id="set-cal-auto"
          label={t("settings.calendar.autoSync")}
          hint={t("settings.calendar.autoSyncHint")}
          checked={v.auto_sync_enabled}
          onCheckedChange={(c) => section.set("auto_sync_enabled", c)}
        />
        {v.auto_sync_enabled ? (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t("settings.calendar.autoSyncCategories")}</legend>
            <div className="flex flex-wrap gap-4">
              {CATEGORIES.map((c) => (
                <Label key={c} className="font-normal">
                  <Checkbox
                    checked={v.auto_sync_categories.includes(c)}
                    onCheckedChange={(on) =>
                      section.set(
                        "auto_sync_categories",
                        on === true ? [...v.auto_sync_categories, c] : v.auto_sync_categories.filter((x) => x !== c),
                      )
                    }
                  />
                  {t(`category.${c}`)}
                </Label>
              ))}
            </div>
          </fieldset>
        ) : null}
      </div>
    </SettingsCard>
  );
}
