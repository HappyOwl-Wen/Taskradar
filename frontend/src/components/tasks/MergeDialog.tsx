import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/form";
import { LoadingRows } from "@/components/ui/states";
import { api } from "@/lib/api";
import { useAction, useTasks } from "@/lib/queries";
import type { TaskDetail } from "@/lib/types";
import { StatusBadge } from "./badges";
import { DueLabel } from "./DueLabel";

/** Manually merge a task into another one (e.g. a duplicate the agent did not catch). Undoable. */
export function MergeDialog({ task, open, onOpenChange }: { task: TaskDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const { data, isLoading } = useTasks({ status: ["candidate", "confirmed", "in_progress", "waiting_for_reply"], q: q || undefined, sort: "due", limit: 50 });
  const merge = useAction((targetId: string) => api.mergeTask(task.id, targetId), {
    success: t("detail.merged"),
    onSuccess: (target) => {
      onOpenChange(false);
      navigate(`/tasks/${target.id}`);
    },
  });
  const options = (data?.items ?? []).filter((x) => x.id !== task.id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("detail.mergeTitle")}</DialogTitle>
          <DialogDescription>{t("detail.mergeDescription")}</DialogDescription>
        </DialogHeader>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("detail.mergeSearch")} aria-label={t("detail.mergeSearch")} autoFocus />
        <div className="scrollbar-thin grid max-h-80 gap-1.5 overflow-y-auto">
          {isLoading ? <LoadingRows rows={3} /> : null}
          {!isLoading && options.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{t("detail.mergeNoResults")}</p> : null}
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={merge.isPending}
              onClick={() => merge.mutate(o.id)}
              className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:border-ring/50 hover:bg-accent/40 disabled:opacity-50"
            >
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="truncate text-sm font-medium">{o.title}</span>
                <StatusBadge status={o.status} />
              </span>
              <DueLabel task={o} showRelative={false} />
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
