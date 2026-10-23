import { useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, Check, ChevronRight, ExternalLink, FileJson, Link2, LoaderCircle, Unplug } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { CalendarConnections } from "@/components/calendar/CalendarConnections";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Label, SwitchRow } from "@/components/ui/form";
import { translateKey } from "@/i18n";
import { api } from "@/lib/api";
import { isDesktopApp, openExternal } from "@/lib/desktop";
import { qk, refreshAll, useAction, useGoogle } from "@/lib/queries";
import { useSection } from "@/lib/settings";
import { CATEGORIES, type Settings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { InfoRow, NumberField, SaveBar, SettingsCard } from "./common";

/**
 * Connecting a Google service. The consent page is Google's own; after approval Google redirects to the local
 * callback, which stores the token in the Windows Credential Manager. In a browser tab the tab goes there and
 * comes back to the settings page. The desktop window opens it in the system browser instead (where the user is
 * signed in to Google; Google does not allow signing in inside embedded windows) and waits here for the result.
 */
function useConnect(service: "calendar") {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: google } = useGoogle();
  // The number of the last authorization result when the browser was opened; null when not waiting.
  const [waitingSince, setWaitingSince] = useState<number | null>(null);

  useEffect(() => {
    if (waitingSince === null) return;
    const timer = setInterval(async () => {
      const status = await queryClient.fetchQuery({ queryKey: qk.google, queryFn: api.google, staleTime: 0 }).catch(() => null);
      const last = status?.last_authorization;
      if (!last || last.seq <= waitingSince) return;
      setWaitingSince(null);
      if (last.ok) toast.success(t("settings.calendar.connectedToast"));
      else toast.error(t("settings.oauthError", { code: translateKey(`errors.${last.error}`, last.error ?? "") }), { duration: 10000 });
      void refreshAll(queryClient);
    }, 1500);
    return () => clearInterval(timer);
  }, [waitingSince, queryClient, service, t]);

  const action = useAction((access: "app" | "read" | "edit" | undefined) => access ? api.connectGoogle(service, access) : api.connectGoogle(service), {
    invalidate: false,
    onSuccess: ({ auth_url }) => {
      if (isDesktopApp()) {
        setWaitingSince(google?.last_authorization?.seq ?? 0);
        openExternal(auth_url);
      } else {
        window.location.assign(auth_url);
      }
    },
  });
  return { mutate: action.mutate, isPending: action.isPending, waiting: waitingSince !== null, stopWaiting: () => setWaitingSince(null) };
}

/** Shown while Google's page is open in the browser (desktop app): what to do, and a way to stop waiting. */
function BrowserWait({ connect }: { connect: ReturnType<typeof useConnect> }) {
  const { t } = useTranslation();
  if (!connect.waiting) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md bg-selected px-3 py-2 text-[13px] text-selected-foreground">
      <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
      <span className="min-w-0 flex-1 basis-56">
        <ExternalLink className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
        {t("settings.google.waitingBrowser")}
      </span>
      <Button variant="ghost" size="xs" onClick={connect.stopWaiting}>
        {t("settings.google.stopWaiting")}
      </Button>
    </div>
  );
}

function Disconnect({ label }: { label: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const disconnect = useAction(() => api.disconnectGoogle("calendar"), {
    success: t("settings.calendar.disconnected"),
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
        description={t("settings.calendar.disconnectHint")}
        confirmLabel={label}
        cancelLabel={t("common.cancel")}
        destructive
        pending={disconnect.isPending}
        onConfirm={() => disconnect.mutate(undefined)}
      />
    </>
  );
}

/** Pick the OAuth client JSON (step 1 of connecting Google Calendar). */
function ClientUpload() {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const upload = useAction((file: File) => api.uploadClientConfig(file), { success: t("settings.google.clientSaved") });
  return (
    <div>
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
      <Button size="sm" onClick={() => input.current?.click()} disabled={upload.isPending}>
        <FileJson /> {t("settings.google.uploadClient")}
      </Button>
    </div>
  );
}

function ClientConfig() {
  const { t } = useTranslation();
  const { data: google } = useGoogle();
  const input = useRef<HTMLInputElement>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const upload = useAction((file: File) => api.uploadClientConfig(file), { success: t("settings.google.clientSaved") });
  const remove = useAction(() => api.deleteClientConfig(), { onSuccess: () => setRemoveOpen(false) });
  const client = google?.client;
  return (
    <div className="grid gap-2 rounded-lg bg-card p-4">
      <p className="text-sm font-semibold">{t("settings.google.clientTitle")}</p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t("settings.google.clientHint")}</p>
      <p className="text-sm">
        {client?.configured ? (
          <span className="text-success">{t("settings.google.clientConfigured", { hint: client.client_id_hint ?? "" })}</span>
        ) : (
          <span className="text-muted-foreground">{t("settings.google.clientMissing")}</span>
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
          <FileJson /> {t("settings.google.uploadClient")}
        </Button>
        {client?.configured ? (
          <Button variant="ghost" size="sm" onClick={() => setRemoveOpen(true)}>
            {t("settings.google.removeClient")}
          </Button>
        ) : null}
      </div>
      {google ? (
        <dl className="mt-1 grid gap-2">
          <InfoRow label={t("settings.google.redirectUri")}>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{google.redirect_uri}</code>
          </InfoRow>
        </dl>
      ) : null}
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("settings.google.removeClient")}
        description={t("settings.google.clientHint")}
        confirmLabel={t("settings.google.removeClient")}
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
    <InfoRow label={t("settings.google.scopes")}>
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

/** One step of connecting Google Calendar: what to do, how to tell it worked, and the action. */
function Step({ index, state, title, hint, children }: { index: number; state: "done" | "current" | "todo"; title: string; hint: string; children?: ReactNode }) {
  return (
    <li className={cn("flex items-start gap-3 rounded-md border p-3", state === "current" && "border-primary/40 bg-selected/60")}>
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold",
          state === "done" ? "bg-success/15 text-success" : state === "current" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {state === "done" ? <Check className="size-4" aria-hidden /> : index}
      </span>
      <div className="grid min-w-0 flex-1 gap-1.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{hint}</p>
        {children}
      </div>
    </li>
  );
}

/**
 * Google Calendar: until it is connected, two steps (the OAuth client file, then Google's consent page), each with
 * what to do and how to tell it worked; once connected, the connection and the calendar options. TaskRadar only
 * writes events into its own calendar (`calendar.app.created`), never into the user's other calendars.
 */
export function CalendarSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const { data: google } = useGoogle();
  const section = useSection(settings, "calendar");
  const connect = useConnect("calendar");
  const [confirmAuto, setConfirmAuto] = useState(false);
  const v = section.value;
  const connected = Boolean(google?.calendar.connected);
  const clientReady = Boolean(google?.client.configured);
  return (
    <SettingsCard
      id="calendar"
      title={t("settings.sections.calendar")}
      description={t("settings.calendar.intro")}
      footer={<SaveBar dirty={section.dirty} saving={section.saving} onSave={section.save} onReset={section.reset} />}
    >
      {connected ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="success">
              <CalendarCheck /> {t("settings.calendar.connected", { name: google?.calendar.calendar_name ?? v.calendar_name })}
            </Badge>
            <span className="text-[13px] text-muted-foreground">{t(google?.calendar.read ? "workbench.accessRead" : "settings.calendar.ownCalendarOnly")}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => connect.mutate(undefined)} disabled={!clientReady || connect.waiting} loading={connect.isPending}>
              <Link2 /> {t("settings.calendar.reconnect")}
            </Button>
            <Disconnect label={t("settings.calendar.disconnect")} />
          </div>
          <BrowserWait connect={connect} />
        </div>
      ) : google ? (
        <ol className="grid gap-2" aria-label={t("settings.calendar.steps.title")}>
          <Step
            index={1}
            state={clientReady ? "done" : "current"}
            title={t("settings.google.steps.client")}
            hint={clientReady ? t("settings.google.clientConfigured", { hint: google.client.client_id_hint ?? "" }) : t("settings.google.steps.clientHint")}
          >
            {clientReady ? null : <ClientUpload />}
          </Step>
          <Step index={2} state={clientReady ? "current" : "todo"} title={t("settings.calendar.steps.authorize")} hint={t("settings.calendar.steps.authorizeHint")}>
            <div className="grid justify-items-start gap-2">
              <Button size="sm" onClick={() => connect.mutate(undefined)} disabled={!clientReady || connect.waiting} loading={connect.isPending}>
                <Link2 /> {t("settings.calendar.connect")}
              </Button>
              <BrowserWait connect={connect} />
            </div>
          </Step>
        </ol>
      ) : null}
      <CalendarConnections onConnect={(access) => connect.mutate(access)} ready={clientReady} busy={connect.isPending || connect.waiting} />
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
          // Writing to the user's calendar without a per-task confirmation is opt-in, and asked twice.
          onCheckedChange={(c) => (c ? setConfirmAuto(true) : section.set("auto_sync_enabled", false))}
        />
        <ConfirmDialog
          open={confirmAuto}
          onOpenChange={setConfirmAuto}
          title={t("settings.calendar.autoSyncConfirmTitle")}
          description={t("settings.calendar.autoSyncConfirm")}
          confirmLabel={t("settings.calendar.autoSyncConfirmAction")}
          cancelLabel={t("common.cancel")}
          onConfirm={() => {
            section.set("auto_sync_enabled", true);
            setConfirmAuto(false);
          }}
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
      <details className="group/adv border-t pt-4">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-sm font-medium text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 transition-transform group-open/adv:rotate-90" aria-hidden />
          {t("settings.google.advanced")}
        </summary>
        <div className="mt-4 grid gap-4">
          <ClientConfig />
          {google ? (
            <dl className="grid gap-2">
              <Scopes scopes={google.calendar.scopes} />
            </dl>
          ) : null}
        </div>
      </details>
    </SettingsCard>
  );
}
