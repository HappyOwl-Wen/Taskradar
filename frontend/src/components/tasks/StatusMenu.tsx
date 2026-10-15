import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tip,
} from "@/components/ui/menu";
import { api } from "@/lib/api";
import { useAction } from "@/lib/queries";
import { TASK_STATUSES, type TaskStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { STATUS_ICON, STATUS_TEXT } from "./meta";

// Menu items colour their icons grey by default; these win over that rule.
const STATUS_TEXT_MENU: Record<TaskStatus, string> = {
  candidate: "text-violet!",
  confirmed: "text-primary!",
  in_progress: "text-upcoming!",
  waiting_for_reply: "text-high!",
  completed: "text-success!",
  dismissed: "text-muted-foreground!",
};

/**
 * Sets any lifecycle status; every change is recorded and can be undone from the toast.
 * `variant="icon"` is the compact form used in lists (the coloured status icon is the trigger).
 */
export function StatusMenu({
  taskId,
  status,
  size = "sm",
  variant = "button",
  showLabel = false,
}: {
  taskId: string;
  status: TaskStatus;
  size?: "sm" | "xs";
  variant?: "button" | "icon";
  /** With `variant="icon"`: also show the status name next to the icon. */
  showLabel?: boolean;
}) {
  const { t } = useTranslation();
  const change = useAction((next: TaskStatus) => api.setStatus(taskId, next), {
    success: (r) => t(`detail.statusDone.${r.status}`, { title: r.title }),
    undo: (r) => r.undo_event_id,
  });
  const Icon = STATUS_ICON[status];
  const label = t(`status.${status}`);
  const trigger =
    variant === "icon" ? (
      <Button
        variant="ghost"
        size={showLabel ? "xs" : "icon-xs"}
        disabled={change.isPending}
        aria-label={t("tasks.changeStatus", { status: label })}
        // Wide enough for the longest label in every language ("Waiting for reply"); icon only on phones.
        className={cn(STATUS_TEXT[status], showLabel && "justify-start px-1.5 sm:w-[7.75rem]")}
      >
        <Icon />
        {showLabel ? <span className="hidden truncate text-xs font-medium sm:inline">{label}</span> : null}
      </Button>
    ) : (
      <Button variant="outline" size={size} disabled={change.isPending} aria-label={t("tasks.changeStatus", { status: label })}>
        <Icon className={STATUS_TEXT[status]} />
        {label}
        <ChevronDown className="opacity-60" />
      </Button>
    );
  return (
    <DropdownMenu>
      {variant === "icon" && !showLabel ? (
        <Tip content={t("tasks.changeStatus", { status: label })}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </Tip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("tasks.columns.status")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={status} onValueChange={(v) => change.mutate(v as TaskStatus)}>
          {TASK_STATUSES.map((s) => {
            const ItemIcon = STATUS_ICON[s];
            return (
              <DropdownMenuRadioItem key={s} value={s}>
                <ItemIcon className={STATUS_TEXT_MENU[s]} />
                {t(`status.${s}`)}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
