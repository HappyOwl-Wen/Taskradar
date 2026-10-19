import { Ban, ChevronDown, Circle, CircleCheck, Ellipsis, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tip,
} from "@/components/ui/menu";
import { api } from "@/lib/api";
import { useAction } from "@/lib/queries";
import { TASK_STATUSES, type TaskStatus, type TaskSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DeleteTasksDialog } from "./DeleteTaskDialog";
import { STATUS_ICON, STATUS_TEXT } from "./meta";

// Menu items colour their icons grey by default; these win over that rule.
const STATUS_TEXT_MENU: Record<TaskStatus, string> = {
  candidate: "text-tentative!",
  confirmed: "text-muted-foreground!",
  in_progress: "text-progress!",
  waiting_for_reply: "text-waiting!",
  completed: "text-success!",
  dismissed: "text-muted-foreground!",
};

function useStatusChange(taskId: string) {
  const { t } = useTranslation();
  return useAction((next: TaskStatus) => api.setStatus(taskId, next), {
    success: (r) => t(`detail.statusDone.${r.status}`, { title: r.title }),
    undo: (r) => r.undo_event_id,
  });
}

/**
 * Sets the status (to do, in progress, waiting for a reply, completed, dismissed); every change is recorded and can
 * be undone from the toast. Below the statuses, "Delete task…" removes the task for good after a question.
 * `variant="button"` shows the current status (task page); `variant="more"` is the quiet "…" at the end of a
 * list row, next to the one-step actions.
 */
export function StatusMenu({
  taskId,
  title,
  status,
  size = "sm",
  variant = "button",
  onDeleted,
}: {
  taskId: string;
  /** Named in the question before deleting. */
  title: string;
  status: TaskStatus;
  size?: "sm" | "xs";
  variant?: "button" | "more";
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const change = useStatusChange(taskId);
  const [deleting, setDeleting] = useState(false);
  // "Unconfirmed" is only a state of tasks found by earlier versions: shown when it is the current one, never offered.
  const statuses = status === "candidate" ? (["candidate", ...TASK_STATUSES] as TaskStatus[]) : TASK_STATUSES;
  const Icon = STATUS_ICON[status];
  const label = t(`status.${status}`);
  const trigger =
    variant === "more" ? (
      <Button variant="ghost" size="icon-sm" disabled={change.isPending} aria-label={t("tasks.changeStatus", { status: label })} className="touch-target relative text-muted-foreground">
        <Ellipsis />
      </Button>
    ) : (
      <Button variant="outline" size={size} disabled={change.isPending} aria-label={t("tasks.changeStatus", { status: label })}>
        <Icon className={STATUS_TEXT[status]} />
        {label}
        <ChevronDown className="opacity-60" />
      </Button>
    );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align={variant === "more" ? "end" : "start"}>
          <DropdownMenuLabel>{t("tasks.columns.status")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={status} onValueChange={(v) => v !== status && change.mutate(v as TaskStatus)}>
            {statuses.map((s) => {
              const ItemIcon = STATUS_ICON[s];
              return (
                <DropdownMenuRadioItem key={s} value={s} disabled={s === "candidate"}>
                  <ItemIcon className={STATUS_TEXT_MENU[s]} />
                  {t(`status.${s}`)}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
            <Trash2 /> {t("deleteTasks.menu")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteTasksDialog ids={[taskId]} title={title} open={deleting} onOpenChange={setDeleting} onDeleted={onDeleted} />
    </>
  );
}

/**
 * The one-step action at the start of a list row: tick an open task off (or untick a completed one). Dismissed
 * tasks show their state instead; their one-step action ("restore") sits at the end of the row. `onLeaving` lets
 * the list fade the row while it is being completed.
 */
export function CompleteToggle({ task, onLeaving }: { task: TaskSummary; onLeaving?: (leaving: boolean) => void }) {
  const { t } = useTranslation();
  const change = useStatusChange(task.id);
  // What the click asked for is shown at once and kept until the task itself reports a status again (the
  // list refreshed, or the change was undone); a failed request drops it. Box, label and title then agree.
  const [wanted, setWanted] = useState<TaskStatus | null>(null);
  const [reported, setReported] = useState(task.status);
  if (reported !== task.status) {
    setReported(task.status);
    setWanted(null);
  }
  if (task.status === "dismissed") {
    return (
      <Tip content={t("status.dismissed")}>
        <span className={cn("grid size-8 place-items-center", STATUS_TEXT.dismissed)}>
          <Ban className="size-[18px]" aria-hidden />
          <span className="sr-only">{t("status.dismissed")}</span>
        </span>
      </Tip>
    );
  }
  const done = (wanted ?? task.status) === "completed";
  const toggle = () => {
    const next: TaskStatus = done ? "confirmed" : "completed";
    setWanted(next);
    onLeaving?.(true);
    change.mutate(next, {
      onError: () => {
        setWanted(null);
        onLeaving?.(false);
      },
    });
  };
  return (
    <Tip content={done ? t("statusAction.reopen") : t("statusAction.complete")}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? t("taskItem.reopen", { title: task.title }) : t("taskItem.complete", { title: task.title })}
        onClick={toggle}
        disabled={change.isPending}
        className="group/done touch-target relative grid size-8 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-wait"
      >
        {done ? (
          <CircleCheck className="size-5 text-success" aria-hidden />
        ) : (
          <>
            <Circle className="size-5 text-input group-hover/done:hidden" aria-hidden />
            <CircleCheck className="hidden size-5 text-success group-hover/done:block" aria-hidden />
          </>
        )}
      </button>
    </Tip>
  );
}
