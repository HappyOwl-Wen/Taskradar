import { CalendarClock, CircleCheck, Columns2, Copy, Hourglass, Ban, Split, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatDue } from "@/lib/format";
import { useAction } from "@/lib/queries";
import { reasonParts, suggestionPayload } from "@/lib/review";
import type { Suggestion } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DuplicateCompare } from "./DuplicateCompare";
import { EvidenceList } from "./Evidence";
import { TechnicalDetails } from "./TechnicalDetails";

const KIND_ICON: Record<Suggestion["kind"], LucideIcon> = {
  mark_completed: CircleCheck,
  mark_dismissed: Ban,
  update_due: CalendarClock,
  possible_duplicate: Copy,
  mark_waiting: Hourglass,
};

/**
 * A proposal from the agent, in plain language. Nothing changes until the user decides; every
 * decision shows its result and can be undone from the toast or the task's history.
 */
export function SuggestionCard({
  suggestion,
  showTask = true,
  className,
}: {
  suggestion: Suggestion;
  /** Name the task the suggestion is about (lists that are not inside a task). */
  showTask?: boolean;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const [compareOpen, setCompareOpen] = useState(false);
  const kind = suggestion.kind;
  const p = suggestionPayload(suggestion);
  const year = new Date().getFullYear();
  const accept = useAction(() => api.acceptSuggestion(suggestion.id), {
    success: t(`suggestionCard.${kind}.accepted`),
    undo: (r) => r.undo_event_id,
  });
  const reject = useAction(() => api.rejectSuggestion(suggestion.id), {
    success: t(`suggestionCard.${kind}.rejected`),
    undo: (r) => r.undo_event_id,
  });
  const busy = accept.isPending || reject.isPending;
  const Icon = KIND_ICON[kind];
  const task = suggestion.task_title ?? "";
  const newDue = p.dueDate ? formatDue({ due_date: p.dueDate, due_time: p.dueTime }, i18n.language, year) : null;
  const oldDue = p.previousDueDate ? formatDue({ due_date: p.previousDueDate, due_time: null }, i18n.language, year) : null;
  const body =
    kind === "possible_duplicate"
      ? t("suggestionCard.possible_duplicate.body", { task, other: p.otherTitle ?? "—" })
      : kind === "update_due"
        ? t("suggestionCard.update_due.body", { date: newDue ?? "—", previous: oldDue ?? t("due.none") })
        : t(`suggestionCard.${kind}.body`, { task });
  const taskLink = suggestion.task_status === "candidate" ? `/inbox?task=${suggestion.task_id}` : `/tasks/${suggestion.task_id}`;

  return (
    <article className={cn("grid gap-3 rounded-lg border bg-card p-3.5", className)}>
      <header className="flex items-start gap-2.5">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-md", kind === "possible_duplicate" ? "bg-high/12 text-high" : "bg-violet/10 text-violet")}>
          <Icon className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h3 className="text-sm font-semibold">{t(`suggestionCard.${kind}.title`)}</h3>
          <p className="text-[13px] leading-relaxed text-foreground/90">{body}</p>
          {showTask && task && kind !== "possible_duplicate" ? (
            <Link to={taskLink} className="w-fit max-w-full truncate text-xs text-muted-foreground hover:text-foreground hover:underline">
              {t("suggestion.forTask")}: {task}
            </Link>
          ) : null}
        </div>
      </header>

      {suggestion.evidence.length ? (
        <details className="group/ev">
          <summary className="cursor-pointer list-none text-xs text-muted-foreground outline-none select-none hover:text-foreground focus-visible:underline [&::-webkit-details-marker]:hidden">
            <span className="line-clamp-2 italic group-open/ev:hidden">
              {t("suggestionCard.basis")}: “{suggestion.evidence[0].quote}”
            </span>
            <span className="hidden group-open/ev:inline">{t("suggestionCard.hideBasis")}</span>
          </summary>
          <EvidenceList evidence={suggestion.evidence} className="mt-2" />
        </details>
      ) : null}

      <footer className="flex flex-wrap items-center justify-between gap-2">
        <TechnicalDetails
          rows={[
            [t("tech.score"), `${suggestion.confidence.toFixed(2)} ${t("tech.uncalibrated")}`],
            [t("tech.ruleReasons"), reasonParts(suggestion.reason).join(" · ") || "—"],
            [t("tech.suggestionId"), `#${suggestion.id}`],
          ]}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          {kind === "possible_duplicate" ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => reject.mutate(undefined)}>
                <Split /> {t("compare.keepSeparate")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setCompareOpen(true)}>
                <Columns2 /> {t("compare.viewDiff")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => reject.mutate(undefined)}>
                {t(`suggestionCard.${kind}.reject`)}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => accept.mutate(undefined)}>
                {t(`suggestionCard.${kind}.accept`)}
              </Button>
            </>
          )}
        </div>
      </footer>
      {kind === "possible_duplicate" ? <DuplicateCompare suggestion={suggestion} open={compareOpen} onOpenChange={setCompareOpen} /> : null}
    </article>
  );
}
