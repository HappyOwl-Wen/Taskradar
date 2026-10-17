import { Bell, CircleAlert, CircleCheck, FileUp, FolderSearch, LoaderCircle, Mail, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/components/ui/variants";
import { Tip } from "@/components/ui/menu";
import { translateKey } from "@/i18n";
import { durationBetween, formatDateTime, formatMs, formatRelativeTime } from "@/lib/format";
import type { SyncJob } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<string, LucideIcon> = {
  gmail_sync: Mail,
  folder_scan: FolderSearch,
  file_import: FileUp,
  reminder_scan: Bell,
  reprocess: RefreshCw,
};

const STATUS_TONE: Record<SyncJob["status"], BadgeTone> = {
  running: "primary",
  succeeded: "success",
  partial: "high",
  failed: "destructive",
  interrupted: "normal",
};

const STATUS_ICON: Record<SyncJob["status"], LucideIcon> = {
  running: LoaderCircle,
  succeeded: CircleCheck,
  partial: TriangleAlert,
  failed: CircleAlert,
  interrupted: CircleAlert,
};

export function JobItem({ job, timezone, compact = false }: { job: SyncJob; timezone: string; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const Icon = KIND_ICON[job.kind] ?? RefreshCw;
  const StatusIcon = STATUS_ICON[job.status];
  const duration = durationBetween(job.started_at, job.finished_at);
  const counts = [
    job.items_seen ? t("sources.jobs.seen", { count: job.items_seen }) : null,
    job.items_processed ? t("sources.jobs.processed", { count: job.items_processed }) : null,
    job.items_skipped ? t("sources.jobs.skipped", { count: job.items_skipped }) : null,
    job.items_failed ? t("sources.jobs.failed", { count: job.items_failed }) : null,
    job.tasks_created ? t("sources.jobs.created", { count: job.tasks_created }) : null,
    job.tasks_updated ? t("sources.jobs.updated", { count: job.tasks_updated }) : null,
  ].filter(Boolean);
  return (
    <div className={cn("flex items-start gap-3", compact ? "py-2" : "rounded-lg bg-subtle px-3 py-2.5")}>
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{translateKey(`jobKind.${job.kind}`, job.kind)}</span>
          <Badge tone={STATUS_TONE[job.status]}>
            <StatusIcon className={cn(job.status === "running" && "animate-spin")} />
            {t(`jobStatus.${job.status}`)}
          </Badge>
          <Tip content={formatDateTime(job.started_at, i18n.language, timezone)}>
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(job.started_at, i18n.language)} · {translateKey(`jobTrigger.${job.trigger}`, job.trigger)}
              {!compact && duration !== null ? ` · ${formatMs(duration)}` : ""}
            </span>
          </Tip>
        </div>
        {counts.length ? <p className="text-xs text-muted-foreground">{counts.join(" · ")}</p> : null}
        {job.error_code ? (
          <p className="text-xs text-destructive">
            {translateKey(`errors.${job.error_code}`, job.error_message ?? job.error_code)}
            {job.next_retry_at
              ? ` ${t("sources.jobs.nextRetry", { time: formatDateTime(job.next_retry_at, i18n.language, timezone) })}`
              : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}
