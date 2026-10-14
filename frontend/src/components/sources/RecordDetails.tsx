import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "@/components/tasks/badges";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { describeCode, translateKey } from "@/i18n";
import { api } from "@/lib/api";
import { formatDateTime, formatMs, formatPercent } from "@/lib/format";
import type { AgentRun, LinkedTask } from "@/lib/types";

function LinkedTasks({ tasks }: { tasks: LinkedTask[] }) {
  const { t } = useTranslation();
  if (tasks.length === 0) return <p className="text-sm text-muted-foreground">{t("common.none")}</p>;
  return (
    <ul className="grid gap-1.5">
      {tasks.map((task) => (
        <li key={task.id} className="flex items-center gap-2 text-sm">
          <StatusBadge status={task.status} />
          <Link to={`/tasks/${task.id}`} className="min-w-0 flex-1 truncate hover:underline">
            {task.title}
          </Link>
          <Badge tone="outline">{t(`relation.${task.relation}`)}</Badge>
        </li>
      ))}
    </ul>
  );
}

export function RunTrace({ run, timezone }: { run: AgentRun; timezone: string }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{run.extractor}</span>
        {run.model ? <span className="text-muted-foreground">{run.provider}/{run.model}</span> : null}
        <Badge tone={run.status === "succeeded" ? "success" : run.status === "fallback" ? "high" : run.status === "failed" ? "destructive" : "normal"}>
          {run.status}
        </Badge>
        {run.content_type ? <span className="text-muted-foreground">{translateKey(`contentType.${run.content_type}`, run.content_type)}</span> : null}
        <span className="text-muted-foreground">{formatMs(run.latency_ms)}</span>
        <span className="text-muted-foreground">
          {t("insights.candidates")}: {run.candidates_count}
        </span>
        <span className="text-muted-foreground">{formatDateTime(run.created_at, i18n.language, timezone)}</span>
        {run.trace.length ? (
          <button type="button" className="ml-auto text-primary hover:underline" onClick={() => setOpen((o) => !o)}>
            {t("insights.trace")} ({run.trace.length})
          </button>
        ) : null}
      </div>
      {run.error ? <p className="mt-1 text-destructive">{run.error}</p> : null}
      {open ? (
        <pre className="scrollbar-thin mt-2 max-h-64 overflow-auto rounded bg-card p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {JSON.stringify(run.trace, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export function DocumentDetailsDialog({ id, onClose, timezone }: { id: number | null; onClose: () => void; timezone: string }) {
  const { t, i18n } = useTranslation();
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ["document", id], queryFn: () => api.document(id ?? 0), enabled: id !== null });
  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{data?.name ?? t("common.loading")}</DialogTitle>
          {data ? (
            <DialogDescription>
              {[
                data.kind.toUpperCase(),
                translateKey(`itemStatus.${data.status}`, data.status),
                data.extraction_method ? translateKey(`method.${data.extraction_method}`, data.extraction_method) : null,
                data.ocr_engine ? `${t("sources.documents.ocrEngine")}: ${data.ocr_engine}` : null,
                data.language,
                formatDateTime(data.imported_at, i18n.language, timezone),
              ]
                .filter(Boolean)
                .join(" · ")}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {isLoading ? <LoadingRows rows={3} /> : null}
        {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
        {data ? (
          <div className="grid gap-4">
            {data.error_code ? (
              <p className="rounded-md bg-destructive/8 px-3 py-2 text-sm text-destructive">
                {translateKey(`errors.${data.error_code}`, data.error_message ?? data.error_code)}
              </p>
            ) : null}
            {data.warnings.length ? (
              <div className="flex flex-wrap gap-1.5">
                {data.warnings.map((w) => (
                  <Badge key={w} tone="high">
                    {describeCode(w)}
                  </Badge>
                ))}
              </div>
            ) : null}
            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">{t("nav.tasks")}</h3>
              <LinkedTasks tasks={data.tasks} />
            </section>
            {data.original_path ? (
              <p className="font-mono text-xs break-all text-muted-foreground">{data.original_path}</p>
            ) : null}
            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">{t("insights.runsTitle")}</h3>
              {data.runs.length ? data.runs.map((r) => <RunTrace key={r.id} run={r} timezone={timezone} />) : <p className="text-sm text-muted-foreground">{t("insights.runsEmpty")}</p>}
            </section>
            {data.pages.map((p) => (
              <section key={p.page} className="grid gap-1.5">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  {t("common.page", { page: p.page })}
                  <Badge tone="outline">{translateKey(`method.${p.method}`, p.method)}</Badge>
                  {p.ocr_confidence !== null ? <span className="text-xs font-normal text-muted-foreground">OCR {formatPercent(p.ocr_confidence)}</span> : null}
                </h3>
                <pre className="scrollbar-thin max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap">
                  {p.text || "—"}
                </pre>
              </section>
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function MessageDetailsDialog({ id, onClose, timezone }: { id: number | null; onClose: () => void; timezone: string }) {
  const { t, i18n } = useTranslation();
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ["message", id], queryFn: () => api.message(id ?? 0), enabled: id !== null });
  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{data ? data.subject || t("sources.messages.noSubject") : t("common.loading")}</DialogTitle>
          {data ? (
            <DialogDescription>
              {data.sender} · {formatDateTime(data.sent_at, i18n.language, timezone)}
              {data.skip_reason ? ` · ${describeCode(data.skip_reason)}` : ""}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {isLoading ? <LoadingRows rows={3} /> : null}
        {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
        {data ? (
          <div className="grid gap-4">
            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">{t("nav.tasks")}</h3>
              <LinkedTasks tasks={data.tasks} />
            </section>
            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">{t("insights.runsTitle")}</h3>
              {data.runs.length ? data.runs.map((r) => <RunTrace key={r.id} run={r} timezone={timezone} />) : <p className="text-sm text-muted-foreground">{t("insights.runsEmpty")}</p>}
            </section>
            {data.attachments.length ? (
              <section className="grid gap-1">
                <h3 className="text-sm font-semibold">PDF / {t("sources.tabs.documents")}</h3>
                {data.attachments.map((a) => (
                  <p key={a.id} className="text-xs text-muted-foreground">
                    {a.name} · {translateKey(`itemStatus.${a.status}`, a.status)}
                  </p>
                ))}
              </section>
            ) : null}
            <pre className="scrollbar-thin max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap">
              {data.body_text || "—"}
            </pre>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
