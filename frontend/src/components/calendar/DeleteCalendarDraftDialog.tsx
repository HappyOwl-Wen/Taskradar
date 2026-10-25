import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { calendarApi, type CalendarView } from "@/lib/calendar";
import { loadRecovery, RECOVERY_KEY } from "@/lib/calendarRecovery";
import { errorMessage } from "@/lib/errors";

function recoveryValue() {
  try { return localStorage.getItem(RECOVERY_KEY); } catch { return null; }
}

/** Discard the local outbox entry and its matching recovery copy, without committing a Google operation. */
export function DeleteCalendarDraftDialog({ id, title, persisted, onOpenChange, onDeleted }: {
  id?: string; title: string; persisted: boolean; onOpenChange: (open: boolean) => void; onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [snapshot] = useState(recoveryValue);
  const remove = useMutation({
    mutationFn: async () => {
      if (!persisted || !id) return;
      try { await calendarApi.resolve(id, "discard"); }
      catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    },
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: ["calendar-workspace"] });
      const recovery = loadRecovery(), recoveryId = recovery?.id ?? recovery?.draft?.id;
      if ((id && recoveryId === id) || (!persisted && !id && snapshot && recoveryValue() === snapshot)) {
        localStorage.removeItem(RECOVERY_KEY);
      }
      client.setQueriesData<CalendarView>({ queryKey: ["calendar-workspace"] }, view =>
        view && { ...view, drafts: view.drafts.filter(draft => draft.id !== id) });
      onDeleted(); onOpenChange(false);
      toast.success(t("workbench.draftDeleted"));
      void client.invalidateQueries({ queryKey: ["calendar-workspace"] });
    },
  });
  return <ConfirmDialog open onOpenChange={open => { if (!remove.isPending) onOpenChange(open); }}
    title={t("workbench.deleteDraftTitle")}
    description={<><strong className="mb-2 block break-words text-foreground">{title || t("workbench.untitled")}</strong>{t("workbench.deleteDraftDescription")}</>}
    confirmLabel={t("workbench.deleteDraft")} cancelLabel={t("common.cancel")} destructive pending={remove.isPending}
    onConfirm={() => remove.mutate()}>
    {remove.error ? <p role="alert" className="text-sm text-destructive">{errorMessage(remove.error)}</p> : null}
  </ConfirmDialog>;
}
