import { Activity, FileText, GitMerge, Mail, ThumbsUp } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RunTrace } from "@/components/sources/RecordDetails";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/ui/states";
import { translateKey } from "@/i18n";
import { formatMs, formatPercent } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { useAgentRuns, useMetrics } from "@/lib/queries";

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function MetricCard({
  icon,
  title,
  children,
  breakdown,
  labels,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  breakdown?: Record<string, number>;
  labels?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(breakdown ?? {}).filter(([, v]) => v > 0);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span> {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid grid-cols-2 gap-4">{children}</dl>
        {entries.length ? (
          <p className="text-xs text-muted-foreground">
            {t("insights.byStatus")}:{" "}
            {entries.map(([k, v]) => `${labels?.[k] ?? translateKey(`itemStatus.${k}`, translateKey(`status.${k}`, k))} ${v}`).join(" · ")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function InsightsPage() {
  const { t } = useTranslation();
  const timezone = useTimezone();
  const metrics = useMetrics();
  const runs = useAgentRuns();
  const m = metrics.data;
  return (
    <div className="grid gap-6">
      <PageHeader title={t("insights.title")} description={t("insights.description")} />
      {metrics.isLoading ? <LoadingRows rows={4} /> : null}
      {metrics.error ? <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} /> : null}
      {m ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <MetricCard icon={<FileText className="size-4" />} title={t("insights.documents")} breakdown={m.documents.by_status}>
            <Stat label={t("insights.total")} value={m.documents.total} />
            <Stat label={t("insights.successRate")} value={formatPercent(m.documents.success_rate, 1)} />
            <Stat label={t("insights.avgProcessing")} value={formatMs(m.documents.avg_processing_ms)} />
          </MetricCard>
          <MetricCard icon={<Mail className="size-4" />} title={t("insights.messages")} breakdown={m.messages.by_status}>
            <Stat label={t("insights.total")} value={m.messages.total} />
            <Stat label={t("insights.successRate")} value={formatPercent(m.messages.success_rate, 1)} />
          </MetricCard>
          <MetricCard icon={<Activity className="size-4" />} title={t("insights.agent")}>
            <Stat label={t("insights.runs")} value={m.agent.runs} />
            <Stat label={t("insights.avgLatency")} value={formatMs(m.agent.avg_latency_ms)} />
            <Stat label={t("insights.llmRuns")} value={m.agent.llm_runs} />
            <Stat label={t("insights.fallbacks")} value={m.agent.llm_fallbacks} />
            <Stat label={t("insights.tokens")} value={`${m.agent.input_tokens} / ${m.agent.output_tokens}`} />
            <Stat label={t("insights.cost")} value={`$${m.agent.estimated_cost_usd.toFixed(4)}`} />
          </MetricCard>
          <MetricCard icon={<GitMerge className="size-4" />} title={t("insights.dedup")}>
            <Stat label={t("insights.merged")} value={m.dedup.duplicates_merged} />
            <Stat label={t("insights.mergesUndone")} value={m.dedup.merges_undone} />
            <Stat label={t("insights.wrongMergeRate")} value={formatPercent(m.dedup.wrong_merge_rate, 1)} />
          </MetricCard>
          <MetricCard
            icon={<ThumbsUp className="size-4" />}
            title={t("insights.feedback")}
            breakdown={{ ...m.feedback.by_status, dismissed: m.feedback.dismissed, merged: m.feedback.merged_into_other }}
            labels={{ merged: t("insights.mergedAway") }}
          >
            <Stat label={t("insights.accepted")} value={m.feedback.accepted} />
            <Stat label={t("insights.dismissedCount")} value={m.feedback.dismissed} />
            <Stat label={t("insights.mergedAway")} value={m.feedback.merged_into_other} />
            <Stat label={t("insights.precisionProxy")} value={formatPercent(m.feedback.precision_proxy, 1)} />
            <Stat
              label={t("insights.autoChanges")}
              value={m.feedback.automatic_status_changes}
              hint={`${t("insights.autoChangesUndone")}: ${m.feedback.automatic_status_changes_undone}`}
            />
          </MetricCard>
        </div>
      ) : null}

      <section className="grid gap-3">
        <h2 className="text-base font-semibold">{t("insights.runsTitle")}</h2>
        {runs.isLoading ? <LoadingRows rows={3} /> : null}
        {runs.error ? <ErrorState error={runs.error} onRetry={() => void runs.refetch()} /> : null}
        {runs.data && runs.data.items.length === 0 ? <EmptyState icon={Activity} title={t("insights.runsEmpty")} compact /> : null}
        <div className="grid gap-2">
          {runs.data?.items.map((run) => (
            <RunTrace key={run.id} run={run} timezone={timezone} />
          ))}
        </div>
      </section>
    </div>
  );
}
