import type { ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/form";
import type { TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CategoryBadge, ConfidenceMeter, PriorityBadge, ReviewFlag, SourceKinds, StatusBadge } from "./badges";
import { STATUS_ICON } from "./meta";
import { DueLabel } from "./DueLabel";

export function TaskRow({
  task,
  selected,
  onSelectedChange,
  actions,
  showStatus = false,
  active = false,
  onOpen,
  className,
}: {
  task: TaskSummary;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  actions?: ReactNode;
  showStatus?: boolean;
  /** Highlight (e.g. the task shown in the side panel). */
  active?: boolean;
  /** When given, the title opens the task in place instead of navigating. */
  onOpen?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const StatusIcon = STATUS_ICON[task.status];
  const closed = task.status === "completed" || task.status === "dismissed";
  const title = (
    <span className={cn("line-clamp-2 text-sm font-medium leading-snug", closed && "text-muted-foreground line-through decoration-1")}>
      {task.title}
    </span>
  );
  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:border-ring/40",
        active && "border-primary/50 bg-accent/40",
        selected && "border-primary/40",
        className,
      )}
    >
      {onSelectedChange ? (
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => onSelectedChange(v === true)}
          aria-label={task.title}
          className="mt-0.5"
        />
      ) : (
        <StatusIcon className={cn("mt-0.5 size-4 shrink-0", closed ? "text-success" : "text-muted-foreground")} aria-label={t(`status.${task.status}`)} />
      )}
      <div className="grid min-w-0 flex-1 gap-1.5">
        {onOpen ? (
          <button type="button" onClick={onOpen} className="text-left outline-none hover:underline focus-visible:underline">
            {title}
          </button>
        ) : (
          <Link to={`/tasks/${task.id}`} className="outline-none hover:underline focus-visible:underline">
            {title}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {showStatus ? <StatusBadge status={task.status} /> : null}
          <CategoryBadge category={task.category} />
          <PriorityBadge priority={task.priority} />
          {task.needs_review ? <ReviewFlag reasons={task.review_reasons} /> : null}
          <SourceKinds kinds={task.source_kinds} count={task.source_count} />
          {task.status === "candidate" ? <ConfidenceMeter value={task.confidence} /> : null}
          {task.pending_suggestions > 0 ? (
            <span className="rounded bg-violet/10 px-1.5 py-0.5 text-xs text-violet">
              {t("dashboard.stats.suggestions")} · {task.pending_suggestions}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <DueLabel task={task} />
        {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
      </div>
    </div>
  );
}
