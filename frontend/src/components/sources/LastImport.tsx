import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CircleAlert, CircleCheck, CircleMinus, FileCheck2, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { TFunction } from "i18next";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { translateKey } from "@/i18n";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/format";
import { refreshAll, useWaitingCount } from "@/lib/queries";
import type { ImportResult } from "@/lib/types";
import { ACCEPTED_FILES, importSummary, importTotals, replaceImportResult, useLastImport, useUpload } from "@/lib/upload";
import { cn } from "@/lib/utils";

/** Failures the same file may get past on a second attempt; the others need another file. */
const RETRYABLE = new Set(["ocr_failed", "extraction_failed", "internal_error"]);

function canRetry(r: ImportResult): boolean {
  return r.status === "failed" && RETRYABLE.has(r.error_code ?? "") && (r.document_id !== null || r.message_id !== null);
}

/** Process a stored file or mail again (nothing is uploaded twice). */
async function processAgain(r: ImportResult): Promise<ImportResult> {
  if (r.document_id !== null) return { ...(await api.reprocessDocument(r.document_id)), filename: r.filename };
  const o = await api.reprocessMessage(r.message_id as number);
  return {
    ...r,
    status: o.skipped ? "skipped" : "processed",
    error_code: null,
    error_message: null,
    tasks_created: o.tasks_created,
    duplicates_merged: o.duplicates_merged,
    suggestions_created: o.suggestions_created,
    completions_applied: o.completions_applied,
    tasks_updated: o.tasks_updated,
  };
}

/** What became of one file, in plain words. */
function outcome(r: ImportResult, t: TFunction): string {
  if (r.status === "failed") return translateKey(`errors.${r.error_code ?? "parse_failed"}`, r.error_message ?? r.error_code ?? "");
  if (r.status !== "processed") return translateKey(`importStatus.${r.status}`, r.status);
  const parts = [
    r.tasks_created ? t("upload.fileFound", { count: r.tasks_created }) : null,
    r.duplicates_merged ? t("upload.fileMerged", { count: r.duplicates_merged }) : null,
    r.suggestions_created ? t("upload.fileSuggestions", { count: r.suggestions_created }) : null,
    r.tasks_updated ? t("upload.fileUpdated", { count: r.tasks_updated }) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("upload.fileNothing");
}

/**
 * The result of the last import stays visible after the toast is gone: what was found (with the way to
 * confirm it) and what happened to each file. A file that failed can be tried again (when the failure may
 * pass) or replaced by another file, right here.
 */
export function LastImportCard({ maxAgeMinutes, className }: { maxAgeMinutes?: number; className?: string }) {
  const { t, i18n } = useTranslation();
  const [last, dismiss] = useLastImport();
  const input = useRef<HTMLInputElement>(null);
  const upload = useUpload();
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: ({ result }: { index: number; result: ImportResult }) => processAgain(result),
    onSuccess: (updated, { index }) => replaceImportResult(index, updated),
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: () => void refreshAll(queryClient),
  });
  const waiting = useWaitingCount();
  // Age is judged when the page is opened (an old result does not reappear on the dashboard).
  const [openedAt] = useState(() => Date.now());
  if (!last) return null;
  if (maxAgeMinutes !== undefined && openedAt - Date.parse(last.at) > maxAgeMinutes * 60_000) return null;
  const totals = importTotals(last.results);
  // Confirming is the next step only while something still waits; once all is decided it would open an empty list.
  const review = waiting !== 0 && totals.created + totals.suggestions > 0;
  return (
    <section className={cn("grid gap-3 rounded-lg bg-subtle p-4", className)} aria-labelledby="last-import-title">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <FileCheck2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
          <h2 id="last-import-title" className="text-sm font-semibold">
            {t("upload.lastTitle", { count: last.results.length })}
            <span className="ml-2 text-xs font-normal text-muted-foreground">{formatRelativeTime(last.at, i18n.language)}</span>
          </h2>
          <p className="text-[13px] text-muted-foreground">{importSummary(last.results, t)}</p>
        </div>
        <div className="flex items-center gap-1">
          {review ? (
            <Button size="sm" asChild>
              <Link to="/inbox">
                {t("upload.review")} <ArrowRight />
              </Link>
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label={t("upload.dismiss")} className="text-muted-foreground">
            <X />
          </Button>
        </div>
      </div>
      <ul className="grid gap-1.5 border-t border-border/70 pt-3">
        {last.results.map((r, i) => {
          const failed = r.status === "failed";
          const Icon = failed ? CircleAlert : r.status === "processed" && (r.tasks_created || r.suggestions_created || r.duplicates_merged || r.tasks_updated) ? CircleCheck : CircleMinus;
          return (
            <li key={`${r.filename}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
              <Icon className={cn("size-4 shrink-0", failed ? "text-destructive" : Icon === CircleCheck ? "text-success" : "text-muted-foreground")} aria-hidden />
              <span className="min-w-0 flex-1 basis-40 truncate font-medium" title={r.filename}>
                {r.filename}
              </span>
              <span className={cn("min-w-0 [overflow-wrap:anywhere]", failed ? "text-destructive" : "text-muted-foreground")}>{outcome(r, t)}</span>
              {failed && canRetry(r) ? (
                <Button variant="outline" size="xs" className="touch-target relative" onClick={() => retry.mutate({ index: i, result: r })} disabled={retry.isPending}>
                  {retry.isPending && retry.variables.index === i ? <LoaderCircle className="animate-spin" /> : <RotateCcw />} {t("common.retry")}
                </Button>
              ) : failed ? (
                <Button variant="outline" size="xs" className="touch-target relative" onClick={() => input.current?.click()} disabled={upload.isPending}>
                  {t("upload.tryAnother")}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) upload.mutate(files);
        }}
      />
    </section>
  );
}
