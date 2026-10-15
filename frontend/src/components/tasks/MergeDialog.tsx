import { ArrowLeft, GitMerge } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/form";
import { LoadingRows } from "@/components/ui/states";
import { api, type DueChoice } from "@/lib/api";
import { useAction, useTasks } from "@/lib/queries";
import { deadlinesDiffer } from "@/lib/review";
import type { TaskDetail, TaskSummary } from "@/lib/types";
import { StatusBadge } from "./badges";
import { DueChoicePicker } from "./DueChoice";
import { DeadlineIndicator } from "./DueLabel";

/**
 * Manually merge a task into another one (a duplicate the agent did not catch): pick the task to
 * keep, choose the deadline if the two differ, confirm. Undoable.
 */
export function MergeDialog({ task, open, onOpenChange }: { task: TaskDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<TaskSummary | null>(null);
  const [choice, setChoice] = useState<DueChoice | null>(null);
  const { data, isLoading } = useTasks({ status: ["candidate", "confirmed", "in_progress", "waiting_for_reply"], q: q || undefined, sort: "due", limit: 50 });
  const reset = () => {
    setTarget(null);
    setChoice(null);
    setQ("");
  };
  const merge = useAction(({ into, due }: { into: string; due?: DueChoice }) => api.mergeTask(task.id, into, due), {
    success: (r) => t("compare.merged", { title: r.title }),
    undo: (r) => r.undo_event_id,
    onSuccess: (r) => {
      onOpenChange(false);
      reset();
      navigate(`/tasks/${r.id}`);
    },
  });
  const options = (data?.items ?? []).filter((x) => x.id !== task.id);
  const needsChoice = target ? deadlinesDiffer(task, target) : false;
  const effectiveChoice = choice ?? (needsChoice && target && !target.due_date ? "new" : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("detail.mergeTitle")}</DialogTitle>
          <DialogDescription>{target ? t("compare.mergeExplanation", { title: target.title }) : t("detail.mergeDescription")}</DialogDescription>
        </DialogHeader>
        {target ? (
          <div className="grid gap-4">
            <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2">
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="truncate text-sm font-medium">{target.title}</span>
                <StatusBadge status={target.status} />
              </span>
              <DeadlineIndicator task={target} showRelative={false} />
            </div>
            {needsChoice ? <DueChoicePicker existing={target} incoming={task} value={effectiveChoice} onChange={setChoice} disabled={merge.isPending} /> : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={() => setTarget(null)} disabled={merge.isPending}>
                <ArrowLeft /> {t("detail.mergePickOther")}
              </Button>
              <Button
                onClick={() => merge.mutate({ into: target.id, due: needsChoice ? (effectiveChoice ?? undefined) : undefined })}
                disabled={merge.isPending || (needsChoice && effectiveChoice === null)}
              >
                <GitMerge /> {t("compare.merge")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("detail.mergeSearch")} aria-label={t("detail.mergeSearch")} autoFocus />
            <div className="scrollbar-thin grid max-h-80 gap-1.5 overflow-y-auto">
              {isLoading ? <LoadingRows rows={3} /> : null}
              {!isLoading && options.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{t("detail.mergeNoResults")}</p> : null}
              {options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setTarget(o)}
                  className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left transition-colors outline-none hover:border-ring/50 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/40"
                >
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span className="truncate text-sm font-medium" title={o.title}>
                      {o.title}
                    </span>
                    <StatusBadge status={o.status} />
                  </span>
                  <DeadlineIndicator task={o} showRelative={false} />
                </button>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
