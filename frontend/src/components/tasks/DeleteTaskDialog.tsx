import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useAction, useSettings } from "@/lib/queries";

/** Move tasks to the recycle bin, explaining the retention period and Google Calendar side effects. */
export function DeleteTasksDialog({
  ids,
  title,
  open,
  onOpenChange,
  onDeleted,
}: {
  ids: string[];
  /** The task's title when one task is deleted; several are counted instead. */
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  // Both answers carry what useAction needs to warn about an event that stayed in Google Calendar.
  const remove = useAction(async (): Promise<{ deleted?: unknown; undo_event_id?: number; undo_event_ids?: number[]; calendar_warning?: string; calendar_not_removed?: string[] }> => {
    if (ids.length === 1) return api.deleteTask(ids[0]);
    return api.batch(ids, "delete");
  }, {
    success: t("deleteTasks.done", { count: ids.length }),
    undo: (result) => result.undo_event_ids ?? result.undo_event_id,
    onSuccess: () => {
      onOpenChange(false);
      onDeleted?.();
    },
  });
  const calendar = settings?.calendar?.remove_on_dismiss === false ? t("deleteTasks.calendarKept") : t("deleteTasks.calendarRemoved");
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={ids.length === 1 && title ? t("deleteTasks.titleOne", { title }) : t("deleteTasks.title", { count: ids.length })}
      description={`${t("deleteTasks.description", { count: ids.length })} ${calendar}`}
      confirmLabel={t("deleteTasks.confirm")}
      cancelLabel={t("common.cancel")}
      destructive
      pending={remove.isPending}
      onConfirm={() => remove.mutate(undefined)}
    />
  );
}
