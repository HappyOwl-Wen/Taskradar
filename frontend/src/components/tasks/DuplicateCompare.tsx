import { ArrowRight, Copy, GitMerge, Split } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingRows } from "@/components/ui/states";
import { api, type DueChoice } from "@/lib/api";
import { formatDue } from "@/lib/format";
import { useTimezone } from "@/lib/hooks";
import { useAction, useTask } from "@/lib/queries";
import { deadlinesDiffer, reasonParts, suggestionPayload } from "@/lib/review";
import type { Suggestion, TaskDetail } from "@/lib/types";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./badges";
import { DueChoicePicker } from "./DueChoice";
import { sourceTitle, useSourceWhen } from "./sourceMeta";
import { TechnicalDetails } from "./TechnicalDetails";

function Row({ label, incoming, existing, differs, note }: { label: string; incoming: ReactNode; existing: ReactNode; differs?: "conflict" | "different"; note?: string }) {
  const { t } = useTranslation();
  const cell = cn(
    "min-w-0 rounded-md px-2.5 py-1.5 text-sm break-words",
    differs === "conflict" && "bg-urgent/8 ring-1 ring-urgent/35",
    differs === "different" && "bg-muted ring-1 ring-border",
  );
  return (
    <div className="grid gap-1.5 border-b py-2.5 last:border-b-0 sm:grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,1fr)] sm:gap-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground sm:block sm:pt-2">
        {label}
        {note ? <span className={cn("sm:mt-1 sm:block", differs === "conflict" ? "text-urgent" : "text-muted-foreground")}>{note}</span> : null}
      </div>
      <div className={cell}>
        <span className="mb-0.5 block text-[11px] text-muted-foreground sm:hidden">{t("compare.incoming")}</span>
        {incoming}
      </div>
      <div className={cell}>
        <span className="mb-0.5 block text-[11px] text-muted-foreground sm:hidden">{t("compare.existing")}</span>
        {existing}
      </div>
    </div>
  );
}

function Due({ task }: { task: TaskDetail }) {
  const { t, i18n } = useTranslation();
  const due = formatDue(task, i18n.language, new Date().getFullYear());
  if (!due) return <span className="text-muted-foreground">{t("due.none")}</span>;
  return (
    <span className="grid gap-0.5">
      <span className="font-medium">{due}</span>
      {task.due_text ? <span className="text-xs text-muted-foreground">{t("due.original")}: “{task.due_text}”</span> : null}
    </span>
  );
}

function Origin({ task }: { task: TaskDetail }) {
  const timezone = useTimezone();
  const when = useSourceWhen(timezone);
  const { t } = useTranslation();
  const first = task.sources[0];
  if (!first) return <span className="text-muted-foreground">{t("detail.manualSource")}</span>;
  return (
    <span className="grid gap-0.5">
      <span className="truncate" title={sourceTitle(first)}>
        {sourceTitle(first)}
      </span>
      <span className="text-xs text-muted-foreground">
        {when(first)}
        {task.sources.length > 1 ? ` · ${t("compare.moreSources", { count: task.sources.length - 1 })}` : ""}
      </span>
    </span>
  );
}

/**
 * "Possible duplicate" review: the new task and the existing one side by side, conflicts highlighted.
 * Merging keeps the existing task and moves the new task's sources into it; when the deadlines differ
 * the user has to pick the date that stays. Every outcome can be undone.
 */
export function DuplicateCompare({
  suggestion,
  open,
  onOpenChange,
  onMerged,
}: {
  suggestion: Suggestion;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The new task was merged away (lists can move on to the next task). */
  onMerged?: () => void;
}) {
  const { t } = useTranslation();
  const payload = suggestionPayload(suggestion);
  const incoming = useTask(open ? suggestion.task_id : undefined);
  const existing = useTask(open && payload.otherTaskId ? payload.otherTaskId : undefined);
  const [choice, setChoice] = useState<DueChoice | null>(null);
  const close = () => onOpenChange(false);
  const merge = useAction((due: DueChoice | undefined) => api.acceptSuggestion(suggestion.id, due), {
    success: (r) => t("compare.merged", { title: r.title }),
    undo: (r) => r.undo_event_id,
    onSuccess: () => {
      close();
      onMerged?.();
    },
  });
  const keep = useAction(() => api.rejectSuggestion(suggestion.id), {
    success: t("compare.keptSeparate"),
    undo: (r) => r.undo_event_id,
    onSuccess: close,
  });
  const busy = merge.isPending || keep.isPending;

  const a = incoming.data;
  const b = existing.data;
  const loading = incoming.isLoading || existing.isLoading;
  const missing = !loading && (!b || existing.error);
  const needsChoice = a && b ? deadlinesDiffer(a, b) : false;
  // An existing task without a deadline simply takes the new one; anything else is the user's call.
  const effectiveChoice = choice ?? (needsChoice && b && !b.due_date ? "new" : null);
  const canMerge = Boolean(a && b) && (!needsChoice || effectiveChoice !== null) && !busy;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setChoice(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="gap-5 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="size-5 text-urgent" /> {t("compare.title")}
          </DialogTitle>
          <DialogDescription>{t("compare.description")}</DialogDescription>
        </DialogHeader>

        {loading ? <LoadingRows rows={4} /> : null}
        {!loading && a ? (
          <div className="grid">
            <div className="hidden border-b pb-2 text-xs font-semibold text-muted-foreground sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,1fr)] sm:gap-3">
              <span />
              <span className="px-2.5">{t("compare.incoming")}</span>
              <span className="px-2.5">{t("compare.existing")}</span>
            </div>
            {b ? (
              <>
                <Row label={t("compare.fieldTitle")} incoming={<span className="font-medium">{a.title}</span>} existing={<span className="font-medium">{b.title}</span>} />
                <Row label={t("compare.fieldAction")} incoming={a.action_required || a.title} existing={b.action_required || b.title} />
                <Row
                  label={t("compare.fieldDue")}
                  incoming={<Due task={a} />}
                  existing={<Due task={b} />}
                  differs={needsChoice ? (b.due_date ? "conflict" : "different") : undefined}
                  note={needsChoice ? (b.due_date ? t("compare.conflict") : t("compare.onlyNewHasDate")) : undefined}
                />
                <Row label={t("compare.fieldSource")} incoming={<Origin task={a} />} existing={<Origin task={b} />} />
                <Row label={t("compare.fieldStatus")} incoming={<StatusBadge status={a.status} />} existing={<StatusBadge status={b.status} />} />
              </>
            ) : null}
          </div>
        ) : null}
        {missing ? <p className="rounded-md bg-muted px-3 py-2 text-sm">{t("compare.existingMissing")}</p> : null}

        {a && b && needsChoice ? (
          <DueChoicePicker existing={b} incoming={a} value={effectiveChoice} onChange={setChoice} disabled={busy} />
        ) : null}

        {a && b ? (
          <p className="flex gap-2 rounded-md bg-muted/60 px-3 py-2 text-[13px] leading-relaxed">
            <GitMerge className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              {t("compare.mergeExplanation", { title: b.title })}
              {needsChoice && effectiveChoice === "new" ? ` ${t("compare.mergeTakesNewDate")}` : ""}
            </span>
          </p>
        ) : null}

        <TechnicalDetails
          rows={[
            [t("tech.similarity"), `${typeof suggestion.payload.score === "number" ? suggestion.payload.score.toFixed(2) : suggestion.confidence.toFixed(2)} ${t("tech.uncalibrated")}`],
            [t("tech.ruleReasons"), reasonParts(suggestion.reason).join(" · ") || "—"],
            // The extractor's matching keys ("exam_registration"): internal ids, so only here.
            ...(a && b ? [[t("compare.fieldEntities"), `${a.entities.join(", ") || "—"} ↔ ${b.entities.join(", ") || "—"}`] as [string, string]] : []),
            [t("tech.suggestionId"), `#${suggestion.id}`],
          ]}
        />

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t("compare.later")}
          </Button>
          <Button variant="outline" onClick={() => keep.mutate(undefined)} disabled={busy}>
            <Split /> {t("compare.keepSeparate")}
          </Button>
          <Button onClick={() => merge.mutate(needsChoice ? (effectiveChoice ?? undefined) : undefined)} disabled={!canMerge}>
            <ArrowRight /> {t("compare.merge")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
