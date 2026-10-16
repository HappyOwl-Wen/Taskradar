import { Ellipsis, FlaskConical, Folder, FolderPlus, LoaderCircle, Mail, MailPlus, RefreshCw, Settings2, ShieldCheck, Trash2, Upload, type LucideIcon } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { UploadButton } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Checkbox, Input, Label, Switch } from "@/components/ui/form";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, Tip } from "@/components/ui/menu";
import { translateKey } from "@/i18n";
import { api } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { expectSourceActivity, useAction, useSettings, useSystemStatus } from "@/lib/queries";
import type { Settings, Source } from "@/lib/types";
import { cn } from "@/lib/utils";

type Health = "ok" | "attention" | "error" | "off" | "running";

const HEALTH_DOT: Record<Health, string> = {
  ok: "bg-success",
  attention: "bg-high",
  error: "bg-destructive",
  off: "bg-muted-foreground/40",
  running: "bg-primary animate-pulse",
};

function health(source: Source | undefined): Health {
  if (!source) return "off";
  if (source.running) return "running";
  if (!source.enabled) return "off";
  if (source.status === "error") return "error";
  if (source.status === "auth_required") return "attention";
  if (source.status === "ok") return "ok";
  return "off";
}

/** Coloured dot + short status: what state the source is in, at a glance. */
function SourceHealth({ source, label }: { source?: Source; label?: string }) {
  const { t } = useTranslation();
  const h = health(source);
  const text =
    label ??
    (source?.running ? t("sources.gmail.syncing") : source && !source.enabled ? t("common.disabled") : translateKey(`sourceStatus.${source?.status ?? "idle"}`, source?.status ?? ""));
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
      <span className={cn("size-2 rounded-full", HEALTH_DOT[h])} aria-hidden />
      {text}
    </span>
  );
}

function LastSync({ source, timezone, verb }: { source: Source; timezone: string; verb?: string }) {
  const { t, i18n } = useTranslation();
  return (
    <span className="text-xs whitespace-nowrap text-muted-foreground">
      {verb ?? t("sources.gmail.lastSync")}{" "}
      {source.last_sync_at ? (
        <Tip content={formatDateTime(source.last_sync_at, i18n.language, timezone)}>
          <span>{formatRelativeTime(source.last_sync_at, i18n.language)}</span>
        </Tip>
      ) : (
        t("sources.gmail.never")
      )}
    </span>
  );
}

/** A problem with a source, phrased as what to do about it. */
function SourceProblem({ source, action }: { source: Source; action?: ReactNode }) {
  if (!source.last_error_code || source.status === "ok") return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-destructive/8 px-3 py-2 text-xs text-destructive">
      <span className="min-w-0 flex-1">{translateKey(`errors.${source.last_error_code}`, source.last_error_message ?? source.last_error_code)}</span>
      {action}
    </div>
  );
}

function SyncButton({ source, label }: { source: Source; label?: string }) {
  const { t } = useTranslation();
  const sync = useAction(() => api.syncSource(source.id), { success: t("sources.gmail.syncStarted"), onSuccess: () => expectSourceActivity() });
  const busy = sync.isPending || Boolean(source.running);
  return (
    <Button variant="outline" size="xs" onClick={() => sync.mutate(undefined)} disabled={busy || !source.enabled}>
      {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />} {label ?? t("sources.gmail.syncNow")}
    </Button>
  );
}

function Row({ id, icon: Icon, title, meta, status, actions, children }: { id?: string; icon: LucideIcon; title: ReactNode; meta?: ReactNode; status?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <li id={id} className="grid scroll-mt-4 gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="truncate text-sm font-medium">{title}</span>
            {status}
          </div>
          {meta ? <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </li>
  );
}

export function GmailRow({ sources, timezone }: { sources: Source[]; timezone: string }) {
  const { t } = useTranslation();
  const { data: status } = useSystemStatus();
  const { data: settings } = useSettings();
  const source = sources.find((s) => s.kind === "gmail");
  const connected = Boolean(status?.google.gmail_connected) && Boolean(source);
  const readonly = (
    <span className="inline-flex items-center gap-1">
      <ShieldCheck className="size-3.5 text-success" /> {t("sources.gmail.readonly")} (gmail.readonly)
    </span>
  );
  if (!connected || !source) {
    return (
      <Row
        id="gmail"
        icon={Mail}
        title={t("sources.gmail.title")}
        status={<SourceHealth label={t("sources.gmail.notConnected")} />}
        meta={
          <>
            {readonly}
            <span>{t("sources.gmail.notConnectedShort", { days: settings?.gmail.lookback_days ?? 30 })}</span>
          </>
        }
        actions={
          <Button size="xs" asChild>
            <Link to="/settings?section=gmail">
              <Mail /> {t("sources.gmail.connect")}
            </Link>
          </Button>
        }
      />
    );
  }
  return (
    <Row
      id="gmail"
      icon={Mail}
      title={source.account || t("sources.gmail.title")}
      status={<SourceHealth source={source} />}
      meta={
        <>
          <LastSync source={source} timezone={timezone} />
          {source.messages ? <span>{t("sources.messagesCount", { count: source.messages })}</span> : null}
          {readonly}
        </>
      }
      actions={
        <>
          <SyncButton source={source} />
          <Tip content={t("sources.settingsHint")}>
            <Button variant="ghost" size="icon-xs" asChild aria-label={t("sources.settingsHint")}>
              <Link to="/settings?section=gmail">
                <Settings2 />
              </Link>
            </Button>
          </Tip>
        </>
      }
    >
      <SourceProblem
        source={source}
        action={
          source.status === "auth_required" ? (
            <Button size="xs" asChild>
              <Link to="/settings?section=gmail">{t("settings.gmail.reconnect")}</Link>
            </Button>
          ) : null
        }
      />
    </Row>
  );
}

export function DemoRow({ source, timezone }: { source: Source; timezone: string }) {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const [removeOpen, setRemoveOpen] = useState(false);
  const advance = useAction(() => api.advanceDemo(), { success: t("sources.demo.advanced") });
  const failure = useAction((mode: string) => api.setFailureMode(mode), { success: t("common.saved") });
  const remove = useAction(() => api.deleteSource(source.id), { onSuccess: () => setRemoveOpen(false) });
  const mode = settings?.demo.gmail_failure_mode ?? "none";
  const modes: Settings["demo"]["gmail_failure_mode"][] = ["none", "rate_limit", "server_error", "auth", "network"];
  return (
    <Row
      id="demo"
      icon={FlaskConical}
      title={t("sources.demo.title")}
      status={<SourceHealth source={source} />}
      meta={
        <>
          <LastSync source={source} timezone={timezone} />
          {source.messages ? <span>{t("sources.messagesCount", { count: source.messages })}</span> : null}
          <span>{t("sources.demo.syntheticNote")}</span>
          {mode !== "none" ? <span className="text-urgent">{t("sources.demo.failureActive", { mode: t(`sources.demo.failure.${mode}`) })}</span> : null}
        </>
      }
      actions={
        <>
          <SyncButton source={source} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={`${t("common.actions")}: ${t("sources.demo.title")}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={() => advance.mutate(undefined)} disabled={advance.isPending}>
                <MailPlus /> {t("sources.demo.advance")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("sources.demo.failureMode")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={mode} onValueChange={(v) => failure.mutate(v)}>
                {modes.map((m) => (
                  <DropdownMenuRadioItem key={m} value={m}>
                    {t(`sources.demo.failure.${m}`)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setRemoveOpen(true)}>
                <Trash2 /> {t("sources.demo.remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <SourceProblem source={source} />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("sources.demo.remove")}
        description={t("sources.demo.removeDescription")}
        confirmLabel={t("sources.demo.remove")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </Row>
  );
}

function FolderRow({ source, timezone }: { source: Source; timezone: string }) {
  const { t } = useTranslation();
  const [removeOpen, setRemoveOpen] = useState(false);
  const toggle = useAction((enabled: boolean) => api.patchSource(source.id, enabled), {
    success: (r) => (r.enabled ? t("sources.folders.resumed") : t("sources.folders.paused")),
  });
  const remove = useAction(() => api.deleteSource(source.id), { success: t("sources.folders.removed"), onSuccess: () => setRemoveOpen(false) });
  return (
    <Row
      icon={Folder}
      title={
        <span className="font-mono text-xs" title={source.folder_path ?? ""}>
          {source.folder_path}
        </span>
      }
      status={<SourceHealth source={source} />}
      meta={
        <>
          <LastSync source={source} timezone={timezone} verb={t("sources.folders.lastScan")} />
          <span>{t("sources.folders.files", { count: source.documents ?? 0 })}</span>
          {source.recursive ? <span>{t("sources.folders.recursive")}</span> : null}
        </>
      }
      actions={
        <>
          <SyncButton source={source} label={t("sources.folders.scanNow")} />
          <Tip content={source.enabled ? t("sources.folders.pause") : t("sources.folders.resume")}>
            <span className="inline-flex">
              <Switch checked={source.enabled} onCheckedChange={(v) => toggle.mutate(v)} aria-label={`${t("sources.folders.watching")}: ${source.folder_path ?? ""}`} />
            </span>
          </Tip>
          <Tip content={t("sources.folders.remove")}>
            <Button variant="ghost" size="icon-xs" onClick={() => setRemoveOpen(true)} aria-label={`${t("sources.folders.remove")}: ${source.folder_path ?? ""}`}>
              <Trash2 />
            </Button>
          </Tip>
        </>
      }
    >
      <SourceProblem source={source} />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("sources.folders.removeTitle")}
        description={
          <>
            <span className="font-mono text-xs break-all text-foreground">{source.folder_path}</span>
            <br />
            {t("sources.folders.removeDescription")}
          </>
        }
        confirmLabel={t("sources.folders.remove")}
        cancelLabel={t("common.cancel")}
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </Row>
  );
}

export function AddFolderForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [recursive, setRecursive] = useState(false);
  const add = useAction(() => api.addFolder(path.trim(), recursive), {
    success: t("sources.folders.added"),
    onSuccess: () => {
      expectSourceActivity();
      setPath("");
      setRecursive(false);
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (path.trim()) add.mutate(undefined);
  };
  return (
    <li id="folders" className="grid scroll-mt-4 gap-2 bg-muted/30 px-4 py-3">
      <form onSubmit={submit} className="grid gap-2">
        <Label htmlFor="add-folder" className="text-[13px]">
          {t("sources.folders.add")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("sources.folders.description")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="add-folder"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("sources.folders.pathPlaceholder")}
            className="h-8 min-w-60 flex-1 font-mono text-xs"
            autoFocus
          />
          <Label className="text-[13px] font-normal">
            <Checkbox checked={recursive} onCheckedChange={(v) => setRecursive(v === true)} />
            {t("sources.folders.recursive")}
          </Label>
          <Button type="submit" size="sm" disabled={!path.trim() || add.isPending}>
            {add.isPending ? <LoaderCircle className="animate-spin" /> : <FolderPlus />} {t("sources.folders.addConfirm")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={add.isPending}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    </li>
  );
}

export function FolderRows({ sources, timezone }: { sources: Source[]; timezone: string }) {
  return (
    <>
      {sources
        .filter((s) => s.kind === "folder")
        .map((f) => (
          <FolderRow key={f.id} source={f} timezone={timezone} />
        ))}
    </>
  );
}

/** Mails and files imported as test data: kept apart from real data and removable in one go. */
export function SampleRow({ source }: { source: Source }) {
  const { t } = useTranslation();
  const [removeOpen, setRemoveOpen] = useState(false);
  const remove = useAction(() => api.deleteSource(source.id), {
    success: (r) => t("sample.removed", { count: r.removed_tasks ?? 0 }),
    onSuccess: () => setRemoveOpen(false),
  });
  const items = (source.messages ?? 0) + (source.documents ?? 0);
  return (
    <Row
      id="test-data"
      icon={FlaskConical}
      title={t("sample.sourceTitle")}
      meta={
        <>
          <span>{t("sample.sourceItems", { count: items })}</span>
          <span>{t("sample.sourceNote")}</span>
        </>
      }
      actions={
        <Tip content={t("sample.remove")}>
          <Button variant="ghost" size="icon-xs" onClick={() => setRemoveOpen(true)} aria-label={t("sample.remove")}>
            <Trash2 />
          </Button>
        </Tip>
      }
    >
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("sample.remove")}
        description={t("sample.removeDescription")}
        confirmLabel={t("sample.remove")}
        cancelLabel={t("common.cancel")}
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </Row>
  );
}

export function UploadsRow({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <Row
      id="uploads"
      icon={Upload}
      title={t("sources.uploads.title")}
      meta={<span>{count ? t("sources.folders.files", { count }) : t("sources.uploads.description")}</span>}
      actions={<UploadButton variant="outline" />}
    />
  );
}

/** "Add source" menu: everything that can be connected, in one place. */
export function AddSourceMenu({ sources, onAddFolder }: { sources: Source[]; onAddFolder: () => void }) {
  const { t } = useTranslation();
  const { data: status } = useSystemStatus();
  const hasDemo = sources.some((s) => s.kind === "demo_mail");
  const create = useAction(
    async () => {
      const created = await api.createDemoMailbox();
      await api.syncSource(created.id);
      return created;
    },
    { success: t("onboarding.demoCreated"), onSuccess: () => expectSourceActivity() },
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <FolderPlus /> {t("sources.addSource")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {!status?.google.gmail_connected ? (
          <DropdownMenuItem asChild>
            <Link to="/settings?section=gmail">
              <Mail /> {t("onboarding.gmail")}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onAddFolder}>
          <Folder /> {t("sources.folders.add")}
        </DropdownMenuItem>
        {!hasDemo ? (
          <DropdownMenuItem onSelect={() => create.mutate(undefined)} disabled={create.isPending}>
            <FlaskConical /> {t("sources.demo.create")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
