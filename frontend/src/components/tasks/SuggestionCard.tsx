import { ArrowRight, CalendarClock, Check, CircleCheck, Copy, Hourglass, Ban, X, type LucideIcon } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useAction } from "@/lib/queries";
import type { Suggestion } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ConfidenceMeter } from "./badges";
import { EvidenceList } from "./Evidence";

const KIND_ICON: Record<Suggestion["kind"], LucideIcon> = {
  mark_completed: CircleCheck,
  mark_dismissed: Ban,
  update_due: CalendarClock,
  possible_duplicate: Copy,
  mark_waiting: Hourglass,
};

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** An agent proposal that needs the user's decision; nothing changes until "accept" is clicked. */
export function SuggestionCard({ suggestion, showTask = true, className }: { suggestion: Suggestion; showTask?: boolean; className?: string }) {
  const { t, i18n } = useTranslation();
  const accept = useAction(() => api.acceptSuggestion(suggestion.id), { success: t("suggestion.accepted") });
  const reject = useAction(() => api.rejectSuggestion(suggestion.id), { success: t("suggestion.rejected") });
  const Icon = KIND_ICON[suggestion.kind];
  const busy = accept.isPending || reject.isPending;
  const year = new Date().getFullYear();
  const newDate = str(suggestion.payload.due_date);
  const newTime = str(suggestion.payload.due_time);
  const prevDate = str(suggestion.payload.previous_due_date);
  const otherTitle = str(suggestion.payload.other_title) ?? suggestion.related_task_title ?? null;

  return (
    <article className={cn("grid gap-3 rounded-lg border bg-card p-3.5", className)}>
      <header className="flex items-start gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-violet/10 text-violet">
          <Icon className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="text-sm font-medium">{t(`suggestionKind.${suggestion.kind}`)}</p>
          {showTask && suggestion.task_title ? (
            <Link to={`/tasks/${suggestion.task_id}`} className="truncate text-[13px] text-muted-foreground hover:text-foreground hover:underline">
              {t("suggestion.forTask")}: {suggestion.task_title}
            </Link>
          ) : null}
        </div>
        <ConfidenceMeter value={suggestion.confidence} />
      </header>

      {suggestion.kind === "update_due" && newDate ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-[13px]">
          <span className="text-muted-foreground line-through">{prevDate ? formatDate(prevDate, i18n.language, year) : t("due.none")}</span>
          <ArrowRight className="size-3.5 text-muted-foreground" />
          <span className="font-medium">
            {formatDate(newDate, i18n.language, year)}
            {newTime ? ` ${newTime}` : ""}
          </span>
        </div>
      ) : null}
      {suggestion.kind === "possible_duplicate" && otherTitle ? (
        <p className="rounded-md bg-muted/60 px-3 py-2 text-[13px]">
          {t("suggestion.duplicateOf", { title: otherTitle })}
          {suggestion.related_task_id ? (
            <Link to={`/tasks/${suggestion.related_task_id}`} className="ml-2 text-primary hover:underline">
              {t("common.open")}
            </Link>
          ) : null}
        </p>
      ) : null}

      <EvidenceList evidence={suggestion.evidence} />
      {suggestion.reason ? <p className="font-mono text-[11px] leading-relaxed break-all text-muted-foreground">{suggestion.reason}</p> : null}

      <footer className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => reject.mutate(undefined)}>
          <X /> {t("common.reject")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => accept.mutate(undefined)}>
          <Check /> {t("common.accept")}
        </Button>
      </footer>
    </article>
  );
}
