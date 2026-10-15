import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, ScanText } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { refreshAll, useAction, useSystemStatus } from "@/lib/queries";

/**
 * Files imported while no OCR engine was available: say so, and once OCR is installed offer to read
 * them again (a background job; the page refreshes when it finishes).
 */
export function OcrBacklogNotice() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: status } = useSystemStatus();
  const reprocessing = status?.ocr.reprocessing ?? false;
  const wasReprocessing = useRef(reprocessing);
  useEffect(() => {
    if (wasReprocessing.current && !reprocessing) {
      toast.success(t("sources.ocrBacklog.done"));
      void refreshAll(queryClient);
    }
    wasReprocessing.current = reprocessing;
  }, [reprocessing, queryClient, t]);
  const reread = useAction(() => api.reprocessOcrBacklog(), {
    success: (r) => (r.accepted ? t("sources.ocrBacklog.started", { count: r.count }) : null),
  });

  const count = status?.ocr.backlog ?? 0;
  if (!status || (count === 0 && !reprocessing)) return null;
  const ready = status.ocr.available;
  const message = reprocessing ? "running" : ready ? "ready" : "missing";
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-high/40 bg-high/8 px-4 py-3 text-sm">
      <p className="flex min-w-0 flex-1 items-start gap-2">
        {reprocessing ? (
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-high" />
        ) : (
          <ScanText className="mt-0.5 size-4 shrink-0 text-high" />
        )}
        <span>{t(`sources.ocrBacklog.${message}`, { count })}</span>
      </p>
      {reprocessing ? null : ready ? (
        <Button size="sm" onClick={() => reread.mutate(undefined)} disabled={reread.isPending}>
          {reread.isPending ? <LoaderCircle className="animate-spin" /> : <ScanText />} {t("sources.ocrBacklog.action")}
        </Button>
      ) : (
        <Button size="sm" variant="outline" asChild>
          <Link to="/settings?section=system">{t("sources.ocrBacklog.howTo")}</Link>
        </Button>
      )}
    </div>
  );
}
