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
} from "@/components/ui/menu";
import { api } from "@/lib/api";
import { useAction } from "@/lib/queries";
import { TASK_STATUSES, type TaskStatus } from "@/lib/types";
import { STATUS_ICON } from "./meta";

/** Dropdown that sets any lifecycle status; every change is recorded and can be undone. */
export function StatusMenu({ taskId, status, size = "sm" }: { taskId: string; status: TaskStatus; size?: "sm" | "xs" }) {
  const { t } = useTranslation();
  const change = useAction((next: TaskStatus) => api.setStatus(taskId, next), { success: t("tasks.statusChanged") });
  const Icon = STATUS_ICON[status];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={size} disabled={change.isPending} aria-label={t("tasks.columns.status")}>
          <Icon />
          {t(`status.${status}`)}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("tasks.columns.status")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={status} onValueChange={(v) => change.mutate(v as TaskStatus)}>
          {TASK_STATUSES.map((s) => {
            const ItemIcon = STATUS_ICON[s];
            return (
              <DropdownMenuRadioItem key={s} value={s}>
                <ItemIcon />
                {t(`status.${s}`)}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
