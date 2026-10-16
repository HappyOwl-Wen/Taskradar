import { Ban, ScanSearch } from "lucide-react";
import type { TFunction } from "i18next";
import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/form";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { formatList } from "@/lib/format";
import { useAction, useRecheck } from "@/lib/queries";
import { reviewReasonLabel } from "@/lib/review";
import type { RecheckItem } from "@/lib/types";
import { StatusBadge } from "./badges";

function Verdict({ item }: { item: RecheckItem }) {
  const { t, i18n } = useTranslation();
  if (item.verdict === "overmerged") {
    return <>{t("recheck.verdict.overmerged", { total: item.sources_total, supporting: item.sources_supporting })}</>;
  }
  if (item.verdict === "doubtful") {
    return <>{t("recheck.verdict.doubtful", {
          doubts: formatList(
            item.doubts.map((d) => reviewReasonLabel(d, t)),
            i18n.language,
          ),
        })}</>;
  }
  return <>{t("recheck.verdict.not_found")}</>;
}

/** "rules:rules-1.6" → "rules-1.6", "llm:<model>" → "<model>"; versions from before they were recorded are "unknown". */
function extractorLabel(version: string, t: TFunction): string {
  if (version === "unknown") return t("recheck.olderVersion");
  return version.replace(/^(rules|llm):/, "");
}

/**
 * Re-check old tasks with the current rules (read-only on the server). The user picks what to dismiss;
 * dismissing is an ordinary status change with undo - nothing is deleted.
 */
export function RecheckDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const { data, isLoading, isFetching, error, refetch } = useRecheck(open);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const ids = new Set(data?.items.map((i) => i.task.id));
  const picked = [...chosen].filter((id) => ids.has(id));
  const close = () => {
    setChosen(new Set());
    onOpenChange(false);
  };
  const dismiss = useAction(() => api.batch(picked, "dismiss"), {
    success: (r) => t("recheck.dismissed", { count: r.count }),
    undo: (r) => r.undo_event_ids,
    onSuccess: () => {
      setChosen(new Set());
      void refetch();
    },
  });
  const toggle = (id: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const notFound = data?.items.filter((i) => i.verdict === "not_found").map((i) => i.task.id) ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanSearch className="size-5 text-muted-foreground" /> {t("recheck.title")}
          </DialogTitle>
          <DialogDescription>{t("recheck.description")}</DialogDescription>
        </DialogHeader>
        {isLoading ? <LoadingRows rows={3} /> : null}
        {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
        {data ? (
          data.items.length === 0 ? (
            <p className="rounded-md bg-muted px-3 py-3 text-sm">{t("recheck.none", { checked: data.checked })}</p>
          ) : (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground">
                <span>{t("recheck.summary", { checked: data.checked, count: data.items.length, rules: data.rules_version })}</span>
                {notFound.length ? (
                  <Button variant="ghost" size="xs" onClick={() => setChosen(new Set(notFound))}>
                    {t("recheck.selectNotFound", { count: notFound.length })}
                  </Button>
                ) : null}
              </div>
              <ul className="max-h-[50vh] divide-y overflow-y-auto rounded-lg border">
                {data.items.map((item) => (
                  <li key={item.task.id} className="flex items-start gap-3 px-3 py-2.5">
                    <Checkbox
                      checked={chosen.has(item.task.id)}
                      onCheckedChange={(v) => toggle(item.task.id, v === true)}
                      aria-label={t("taskItem.select", { title: item.task.title })}
                      className="mt-0.5"
                    />
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/tasks/${item.task.id}`} className="min-w-0 truncate text-sm font-medium hover:underline" title={item.task.title} onClick={close}>
                          {item.task.title}
                        </Link>
                        <StatusBadge status={item.task.status} />
                      </div>
                      <p className="text-[13px] leading-relaxed text-muted-foreground">
                        <Verdict item={item} />
                        {item.extracted_by.length ? ` · ${t("recheck.extractedBy", {
                          versions: formatList(
                            item.extracted_by.map((v) => extractorLabel(v, t)),
                            i18n.language,
                          ),
                        })}` : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{t("recheck.safety")}</p>
            </div>
          )
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t("common.close")}
          </Button>
          <Button onClick={() => dismiss.mutate(undefined)} disabled={picked.length === 0 || dismiss.isPending || isFetching}>
            <Ban /> {t("recheck.dismissSelected", { count: picked.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
