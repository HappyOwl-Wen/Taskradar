import { Activity, ChevronRight, History } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { SystemStatusList } from "@/components/layout/SystemStatus";
import { JobItem } from "@/components/sources/JobItem";
import { RunTrace } from "@/components/sources/RecordDetails";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingRows } from "@/components/ui/states";
import { translateKey } from "@/i18n";
import { formatMs, formatRelativeTime } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { useAgentRuns, useFailures, useJobs, useMetrics, useSources, useSystemStatus } from "@/lib/queries";
import type { Metrics, SyncJob } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Rates are only shown once enough decisions exist; below that a percentage would mislead. */
const MIN_FOR_RATE = 10;

function Section({ title, hint, aside, children }: { title: string; hint?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="text-section font-semibold">{title}</h2>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function HealthRow({ state, title, detail, action }: { state: "ok" | "warn" | "error" | "off"; title: string; detail: ReactNode; action?: ReactNode }) {
  const dot = { ok: "bg-success", warn: "bg-urgent", error: "bg-destructive", off: "bg-muted-foreground/40" }[state];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden />
      <span className="w-36 shrink-0 text-sm font-medium">{title}</span>
      <span className="min-w-0 flex-1 text-[13px] text-muted-foreground">{detail}</span>
      {action}
    </li>
  );
}

function SystemHealth() {
  const { t, i18n } = useTranslation();
  const { data: status } = useSystemStatus();
  const { data: sources } = useSources();
  const { data: jobs } = useJobs();
  if (!status) return <LoadingRows rows={3} />;
  const gmail = sources?.items.find((s) => s.kind === "gmail");
  // Connected means: a Gmail source exists here and its authorization is stored.
  const gmailConnected = status.google.gmail_connected && Boolean(gmail);
  const folders = sources?.items.filter((s) => s.kind === "folder") ?? [];
  // Only runs of this Gmail source (the demo mailbox uses the same kind of job).
  const gmailJob: SyncJob | undefined = gmail ? jobs?.items.find((j) => j.source_id === gmail.id && j.status !== "running") : undefined;
  const ocrName = status.ocr.version ? (/tesseract/i.test(status.ocr.version) ? status.ocr.version : `Tesseract ${status.ocr.version}`) : "Tesseract";
  const folderErrors = folders.filter((f) => f.status === "error").length;
  return (
    <ul className="divide-y rounded-lg border bg-card">
      <HealthRow
        state={!gmailConnected ? "off" : gmail?.status === "ok" ? "ok" : gmail?.status === "auth_required" ? "warn" : gmail?.status === "error" ? "error" : "off"}
        title="Gmail"
        detail={
          !gmailConnected
            ? t("insights.health.gmailOff")
            : [
                translateKey(`sourceStatus.${gmail?.status ?? "idle"}`, gmail?.status ?? ""),
                gmail?.last_success_at ? t("insights.health.lastSuccess", { when: formatRelativeTime(gmail.last_success_at, i18n.language) }) : null,
                gmailJob ? t("insights.health.lastRun", { status: t(`jobStatus.${gmailJob.status}`) }) : null,
              ]
                .filter(Boolean)
                .join(" · ")
        }
        action={
          gmailConnected && gmail?.status === "auth_required" ? (
            <Button size="xs" asChild>
              <Link to="/settings?section=gmail">{t("settings.gmail.reconnect")}</Link>
            </Button>
          ) : null
        }
      />
      <HealthRow
        state={folders.length === 0 ? "off" : folderErrors ? "error" : "ok"}
        title={t("sources.folders.title")}
        detail={folders.length === 0 ? t("insights.health.noFolders") : folderErrors ? t("insights.health.folderErrors", { count: folderErrors }) : t("insights.health.folders", { count: folders.length })}
      />
      <HealthRow
        state={status.ocr.available ? (status.ocr.backlog ? "warn" : "ok") : "warn"}
        title={t("insights.health.ocr")}
        detail={
          status.ocr.available
            ? [
                ocrName,
                status.ocr.languages.length ? status.ocr.languages.join(", ") : null,
                status.ocr.backlog ? t("insights.health.ocrBacklog", { count: status.ocr.backlog }) : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : t("insights.health.ocrMissing")
        }
      />
      <HealthRow
        state="ok"
        title={t("insights.health.extraction")}
        detail={status.agent_mode === "llm" ? t("insights.health.llm", { model: `${status.llm.provider}/${status.llm.model}` }) : t("insights.health.rules")}
      />
      <HealthRow
        state={status.scheduler.running ? "ok" : "off"}
        title={t("insights.health.scheduler")}
        detail={status.scheduler.running ? t("insights.health.schedulerOn", { count: status.scheduler.jobs.length }) : t("insights.health.schedulerOff")}
      />
    </ul>
  );
}

function Figure({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="grid content-start gap-0.5 px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Processing({ m }: { m: Metrics }) {
  const { t } = useTranslation();
  const status = (rec: Record<string, number>, key: string) => rec[key] ?? 0;
  const decided = m.feedback.accepted + m.feedback.dismissed;
  const keptShare = decided < MIN_FOR_RATE ? t("insights.tooFew", { min: MIN_FOR_RATE }) : `${Math.round((m.feedback.accepted / decided) * 100)}%`;
  const stillOpen = status(m.feedback.by_status, "candidate");
  return (
    <div className="grid gap-4">
      <dl className="grid divide-y rounded-lg border bg-card sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
        <Figure
          label={t("insights.read")}
          value={t("insights.readValue", { messages: m.messages.total, documents: m.documents.total })}
          hint={t("insights.readHint", {
            failed: status(m.messages.by_status, "failed") + status(m.documents.by_status, "failed"),
            skipped: status(m.messages.by_status, "skipped") + status(m.documents.by_status, "skipped"),
          })}
        />
        <Figure label={t("insights.found")} value={m.feedback.agent_tasks} hint={t("insights.foundHint", { open: stillOpen })} />
        <Figure
          label={t("insights.decisions")}
          value={t("insights.decisionsValue", { accepted: m.feedback.accepted, dismissed: m.feedback.dismissed })}
          hint={t("insights.decisionsHint", { merged: m.feedback.merged_into_other })}
        />
        <Figure
          label={t("insights.keptShare")}
          value={keptShare}
          hint={t("insights.keptShareHint", { accepted: m.feedback.accepted, decided })}
        />
      </dl>
      <dl className="grid divide-y rounded-lg border bg-card sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
        <Figure label={t("insights.merged")} value={m.dedup.duplicates_merged} hint={t("insights.mergedHint", { undone: m.dedup.merges_undone })} />
        <Figure
          label={t("insights.autoChanges")}
          value={m.feedback.automatic_status_changes}
          hint={t("insights.autoChangesHint", { undone: m.feedback.automatic_status_changes_undone })}
        />
        <Figure label={t("insights.avgProcessing")} value={formatMs(m.documents.avg_processing_ms)} hint={t("insights.avgProcessingHint")} />
        <Figure label={t("insights.avgLatency")} value={formatMs(m.agent.avg_latency_ms)} hint={t("insights.avgLatencyHint", { runs: m.agent.runs })} />
      </dl>
      {m.agent.llm_runs > 0 ? (
        <dl className="grid divide-y rounded-lg border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Figure label={t("insights.llmRuns")} value={m.agent.llm_runs} hint={t("insights.fallbacksHint", { count: m.agent.llm_fallbacks })} />
          <Figure label={t("insights.tokens")} value={`${m.agent.input_tokens} / ${m.agent.output_tokens}`} />
          <Figure label={t("insights.cost")} value={`$${m.agent.estimated_cost_usd.toFixed(4)}`} hint={t("insights.costHint")} />
        </dl>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">{t("insights.noLlm")}</p>
      )}
    </div>
  );
}

function FailureReasons() {
  const { t } = useTranslation();
  const { data } = useFailures();
  if (!data) return null;
  const reasons = new Map<string, number>();
  for (const item of [...data.documents, ...data.messages]) {
    const code = (item as { error_code?: string | null }).error_code ?? "unknown";
    reasons.set(code, (reasons.get(code) ?? 0) + 1);
  }
  const total = data.documents.length + data.messages.length;
  if (total === 0 && data.jobs.length === 0) return <p className="rounded-lg border border-dashed px-4 py-3 text-[13px] text-muted-foreground">{t("insights.noFailures")}</p>;
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {[...reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => (
          <li key={code} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0 flex-1">{translateKey(`errors.${code}`, code === "unknown" ? t("insights.unknownError") : code)}</span>
            <span className="text-muted-foreground tabular-nums">×{count}</span>
          </li>
        ))}
      {data.jobs.length ? (
        <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
          <span className="min-w-0 flex-1">{t("insights.failedRuns")}</span>
          <span className="text-muted-foreground tabular-nums">×{data.jobs.length}</span>
        </li>
      ) : null}
      {total ? (
        <li className="px-4 py-2 text-xs">
          <Link to="/sources" className="text-primary hover:underline">
            {t("insights.seeRecords")}
          </Link>
        </li>
      ) : null}
    </ul>
  );
}

function RunHistory() {
  const { t } = useTranslation();
  const timezone = useTimezone();
  const jobs = useJobs();
  const runs = useAgentRuns();
  const [shown, setShown] = useState(8);
  const items = jobs.data?.items ?? [];
  return (
    <div className="grid gap-3">
      {jobs.isLoading ? <LoadingRows rows={3} /> : null}
      {jobs.error ? <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} /> : null}
      {jobs.data && items.length === 0 ? <EmptyState compact icon={History} title={t("sources.jobs.empty")} /> : null}
      {items.length ? (
        <div className="grid divide-y rounded-lg border bg-card px-3">
          {items.slice(0, shown).map((job) => (
            <JobItem key={job.id} job={job} timezone={timezone} compact />
          ))}
        </div>
      ) : null}
      {items.length > shown ? (
        <Button variant="ghost" size="sm" className="w-fit" onClick={() => setShown((n) => n + 20)}>
          {t("records.showMore", { count: items.length - shown })}
        </Button>
      ) : null}
      <details className="group/runs">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-muted-foreground outline-none select-none hover:text-foreground focus-visible:underline [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 transition-transform group-open/runs:rotate-90" aria-hidden />
          {t("insights.runsTitle")} {runs.data ? <span className="font-normal">({runs.data.items.length})</span> : null}
        </summary>
        <div className="mt-2 grid gap-2">
          {runs.isLoading ? <LoadingRows rows={2} /> : null}
          {runs.data && runs.data.items.length === 0 ? <EmptyState icon={Activity} title={t("insights.runsEmpty")} compact /> : null}
          {runs.data?.items.map((run) => (
            <RunTrace key={run.id} run={run} timezone={timezone} />
          ))}
        </div>
      </details>
    </div>
  );
}

export default function InsightsPage() {
  const { t } = useTranslation();
  const metrics = useMetrics();
  return (
    <div className="grid gap-7">
      <header className="grid gap-0.5">
        <h1 className="text-page font-semibold">{t("insights.title")}</h1>
        <p className="text-[13px] text-muted-foreground">{t("insights.description")}</p>
      </header>
      <Section title={t("insights.healthTitle")} hint={t("insights.healthHint")}>
        <SystemStatusList />
      </Section>
      <Section title={t("insights.componentsTitle")}>
        <SystemHealth />
      </Section>
      <Section title={t("insights.processingTitle")} hint={t("insights.processingHint")}>
        {metrics.isLoading ? <LoadingRows rows={2} /> : null}
        {metrics.error ? <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} /> : null}
        {metrics.data ? <Processing m={metrics.data} /> : null}
      </Section>
      <Section title={t("insights.failuresTitle")}>
        <FailureReasons />
      </Section>
      <Section title={t("insights.historyTitle")} hint={t("insights.historyHint")}>
        <RunHistory />
      </Section>
    </div>
  );
}
