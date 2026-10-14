import { FlaskConical, Folder, FolderPlus, LoaderCircle, Mail, MailPlus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/components/ui/variants";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Checkbox, Input, Label, Switch } from "@/components/ui/form";
import { Tip } from "@/components/ui/menu";
import { SimpleSelect } from "@/components/ui/select";
import { translateKey } from "@/i18n";
import { api } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { useAction, useSettings, useSystemStatus } from "@/lib/queries";
import type { Settings, Source } from "@/lib/types";

const STATUS_TONE: Record<string, BadgeTone> = {
  idle: "normal",
  ok: "success",
  error: "destructive",
  auth_required: "high",
  disconnected: "normal",
};

function SourceStatus({ source }: { source: Source }) {
  const { t } = useTranslation();
  if (source.running) {
    return (
      <Badge tone="primary">
        <LoaderCircle className="animate-spin" /> {t("sources.gmail.syncing")}
      </Badge>
    );
  }
  return <Badge tone={STATUS_TONE[source.status] ?? "normal"}>{translateKey(`sourceStatus.${source.status}`, source.status)}</Badge>;
}

function LastSync({ source, timezone }: { source: Source; timezone: string }) {
  const { t, i18n } = useTranslation();
  return (
    <p className="text-xs text-muted-foreground">
      {t("sources.gmail.lastSync")}:{" "}
      {source.last_sync_at ? (
        <Tip content={formatDateTime(source.last_sync_at, i18n.language, timezone)}>
          <span>{formatRelativeTime(source.last_sync_at, i18n.language)}</span>
        </Tip>
      ) : (
        t("sources.gmail.never")
      )}
      {source.messages ? ` · ${source.messages} ✉` : ""}
      {source.documents ? ` · ${t("sources.folders.files", { count: source.documents })}` : ""}
    </p>
  );
}

function SourceError({ source }: { source: Source }) {
  if (!source.last_error_code || source.status === "ok") return null;
  return (
    <p className="rounded-md bg-destructive/8 px-2.5 py-1.5 text-xs text-destructive">
      {translateKey(`errors.${source.last_error_code}`, source.last_error_message ?? source.last_error_code)}
    </p>
  );
}

function SyncButton({ source, label }: { source: Source; label?: string }) {
  const { t } = useTranslation();
  const sync = useAction(() => api.syncSource(source.id), { success: t("sources.gmail.syncStarted") });
  const busy = sync.isPending || Boolean(source.running);
  return (
    <Button variant="outline" size="xs" onClick={() => sync.mutate(undefined)} disabled={busy || !source.enabled}>
      <RefreshCw className={busy ? "animate-spin" : undefined} /> {label ?? t("sources.gmail.syncNow")}
    </Button>
  );
}

function SourceCard({ icon, title, badge, description, children }: { icon: ReactNode; title: string; badge?: ReactNode; description?: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">{icon}</span>
          <div className="grid gap-0.5">
            <CardTitle>{title}</CardTitle>
            {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
          </div>
        </div>
        {badge}
      </CardHeader>
      <CardContent className="grid flex-1 content-start gap-3">{children}</CardContent>
    </Card>
  );
}

export function GmailCard({ sources, timezone }: { sources: Source[]; timezone: string }) {
  const { t } = useTranslation();
  const { data: status } = useSystemStatus();
  const { data: settings } = useSettings();
  const source = sources.find((s) => s.kind === "gmail");
  const connected = Boolean(status?.google.gmail_connected);
  return (
    <SourceCard
      icon={<Mail className="size-4" />}
      title={t("sources.gmail.title")}
      badge={
        connected && source ? (
          <SourceStatus source={source} />
        ) : (
          <Badge tone="normal">{t("sources.gmail.notConnected")}</Badge>
        )
      }
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5 text-success" /> {t("sources.gmail.readonly")} · gmail.readonly
      </p>
      {connected && source ? (
        <>
          {source.account ? (
            <p className="text-sm">
              <span className="text-muted-foreground">{t("sources.gmail.account")}: </span>
              {source.account}
            </p>
          ) : null}
          <LastSync source={source} timezone={timezone} />
          <SourceError source={source} />
          <div className="flex flex-wrap gap-2">
            <SyncButton source={source} />
            {source.status === "auth_required" ? (
              <Button size="xs" asChild>
                <Link to="/settings#gmail">{t("settings.gmail.reconnect")}</Link>
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t("sources.gmail.notConnectedHint", { days: settings?.gmail.lookback_days ?? 30 })}
          </p>
          <Button size="xs" className="w-fit" asChild>
            <Link to="/settings#gmail">
              <Mail /> {t("sources.gmail.connect")}
            </Link>
          </Button>
        </>
      )}
    </SourceCard>
  );
}

export function DemoCard({ sources, timezone }: { sources: Source[]; timezone: string }) {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const [removeOpen, setRemoveOpen] = useState(false);
  const source = sources.find((s) => s.kind === "demo_mail");
  const create = useAction(
    async () => {
      const created = await api.createDemoMailbox();
      await api.syncSource(created.id);
      return created;
    },
    { success: t("onboarding.demoCreated") },
  );
  const advance = useAction(() => api.advanceDemo(), { success: t("sources.demo.advanced") });
  const failure = useAction((mode: string) => api.setFailureMode(mode));
  const remove = useAction((id: number) => api.deleteSource(id), { onSuccess: () => setRemoveOpen(false) });
  const mode = settings?.demo.gmail_failure_mode ?? "none";
  const modes: Settings["demo"]["gmail_failure_mode"][] = ["none", "rate_limit", "server_error", "auth", "network"];

  return (
    <SourceCard
      icon={<FlaskConical className="size-4" />}
      title={t("sources.demo.title")}
      description="demo@taskradar.example"
      badge={source ? <SourceStatus source={source} /> : null}
    >
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t("sources.demo.description")}</p>
      {source ? (
        <>
          <LastSync source={source} timezone={timezone} />
          <SourceError source={source} />
          <div className="flex flex-wrap gap-2">
            <SyncButton source={source} />
            <Tip content={t("sources.demo.advanceHint")}>
              <Button variant="outline" size="xs" onClick={() => advance.mutate(undefined)} disabled={advance.isPending}>
                <MailPlus /> {t("sources.demo.advance")}
              </Button>
            </Tip>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="demo-failure" className="text-xs">
              {t("sources.demo.failureMode")}
            </Label>
            <SimpleSelect
              id="demo-failure"
              className="h-8"
              value={mode}
              onValueChange={(v) => failure.mutate(v)}
              options={modes.map((m) => ({ value: m, label: t(`sources.demo.failure.${m}`) }))}
            />
            <p className="text-xs text-muted-foreground">{t("sources.demo.failureModeHint")}</p>
          </div>
          <Button variant="ghost" size="xs" className="w-fit text-muted-foreground" onClick={() => setRemoveOpen(true)}>
            <Trash2 /> {t("sources.demo.remove")}
          </Button>
          <ConfirmDialog
            open={removeOpen}
            onOpenChange={setRemoveOpen}
            title={t("sources.demo.remove")}
            description={t("sources.messages.deleteDescription")}
            confirmLabel={t("common.delete")}
            cancelLabel={t("common.cancel")}
            destructive
            pending={remove.isPending}
            onConfirm={() => remove.mutate(source.id)}
          />
        </>
      ) : (
        <Button size="xs" className="w-fit" onClick={() => create.mutate(undefined)} disabled={create.isPending}>
          <FlaskConical /> {t("sources.demo.create")}
        </Button>
      )}
    </SourceCard>
  );
}

function FolderRow({ source, timezone }: { source: Source; timezone: string }) {
  const { t } = useTranslation();
  const [removeOpen, setRemoveOpen] = useState(false);
  const toggle = useAction((enabled: boolean) => api.patchSource(source.id, enabled));
  const remove = useAction(() => api.deleteSource(source.id), { success: t("sources.folders.removed"), onSuccess: () => setRemoveOpen(false) });
  return (
    <li className="grid gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-start gap-2">
        <Folder className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate font-mono text-xs" title={source.folder_path ?? ""}>
            {source.folder_path}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <SourceStatus source={source} />
            {source.recursive ? <Badge tone="outline">{t("sources.folders.recursive")}</Badge> : null}
          </div>
        </div>
        <Tip content={source.enabled ? t("common.enabled") : t("common.disabled")}>
          <span>
            <Switch checked={source.enabled} onCheckedChange={(v) => toggle.mutate(v)} aria-label={source.folder_path ?? ""} />
          </span>
        </Tip>
      </div>
      <LastSync source={source} timezone={timezone} />
      <SourceError source={source} />
      <div className="flex flex-wrap gap-2">
        <SyncButton source={source} label={t("sources.folders.scanNow")} />
        <Button variant="ghost" size="xs" onClick={() => setRemoveOpen(true)}>
          <Trash2 /> {t("sources.folders.remove")}
        </Button>
      </div>
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t("sources.folders.remove")}
        description={source.folder_path}
        confirmLabel={t("sources.folders.remove")}
        cancelLabel={t("common.cancel")}
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
    </li>
  );
}

export function FoldersCard({ sources, timezone }: { sources: Source[]; timezone: string }) {
  const { t } = useTranslation();
  const folders = sources.filter((s) => s.kind === "folder");
  const [path, setPath] = useState("");
  const [recursive, setRecursive] = useState(false);
  const add = useAction(() => api.addFolder(path.trim(), recursive), {
    success: t("sources.folders.added"),
    onSuccess: () => {
      setPath("");
      setRecursive(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (path.trim()) add.mutate(undefined);
  };
  return (
    <SourceCard icon={<FolderPlus className="size-4" />} title={t("sources.folders.title")}>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t("sources.folders.description")}</p>
      <form onSubmit={submit} className="grid gap-2">
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={t("sources.folders.pathPlaceholder")}
          aria-label={t("sources.folders.add")}
          className="font-mono text-xs"
        />
        <div className="flex items-center justify-between gap-2">
          <Label className="text-[13px] font-normal">
            <Checkbox checked={recursive} onCheckedChange={(v) => setRecursive(v === true)} />
            {t("sources.folders.recursive")}
          </Label>
          <Button type="submit" size="xs" disabled={!path.trim() || add.isPending}>
            <FolderPlus /> {t("sources.folders.add")}
          </Button>
        </div>
      </form>
      {folders.length === 0 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">{t("sources.folders.empty")}</p>
      ) : (
        <ul className="grid gap-2">
          {folders.map((f) => (
            <FolderRow key={f.id} source={f} timezone={timezone} />
          ))}
        </ul>
      )}
    </SourceCard>
  );
}
