import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { translateKey } from "@/i18n";
import type { CalendarDraft, CalendarSources } from "@/lib/calendar";
import { loadRecovery } from "@/lib/calendarRecovery";
import type { EditorSeed } from "./CalendarEditor";
import { DeleteCalendarDraftDialog } from "./DeleteCalendarDraftDialog";

export function CalendarDrafts({ drafts, sources, recovery, onEdit, onRecoveryChange }: {
  drafts: CalendarDraft[]; sources: CalendarSources["sources"]; recovery: EditorSeed | null;
  onEdit: (seed: EditorSeed) => void; onRecoveryChange: (seed: EditorSeed | null) => void;
}) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState<{ id?: string; title: string; persisted: boolean } | null>(null);
  const recoveryId = recovery?.id ?? recovery?.draft?.id;
  const browserOnly = recovery && !drafts.some(draft => draft.id === recoveryId);
  const title = (value?: string) => value?.trim() || t("workbench.untitled");
  if (!drafts.length && !browserOnly) return null;
  const removeButton = (id: string | undefined, name: string, persisted: boolean) =>
    <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive"
      aria-label={t("workbench.deleteDraftNamed", { title: name })} onClick={() => setDeleting({ id, title: name, persisted })}>
      <Trash2 aria-hidden />{t("workbench.deleteDraft")}
    </Button>;
  return <section className="glass-card grid gap-3 p-4" aria-label={t("workbench.drafts")}>
    <h2 className="text-sm font-semibold">{t("workbench.drafts")}</h2>
    <ul className="grid gap-3">
      {drafts.map(draft => <li key={draft.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="min-w-0 flex-1 basis-48 break-words">{title(draft.payload.title)} · {sources.find(source => source.id === draft.calendar_id)?.summary ?? draft.calendar_id} · {t(`workbench.operation_${draft.operation}`)}
          {draft.last_error ? ` · ${translateKey(`errors.${draft.last_error}`, draft.last_error)}` : ""}</span>
        <div className="flex shrink-0 gap-1">
          <Button variant="outline" size="xs" onClick={() => onEdit({ mode: "google", draft })}>{t("workbench.resume")}</Button>
          {removeButton(draft.id, title(draft.payload.title), true)}
        </div>
      </li>)}
      {browserOnly ? <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="min-w-0 flex-1 basis-48 break-words">{title(recovery.form?.title ?? recovery.draft?.payload.title ?? recovery.title)}</span>
        <div className="flex shrink-0 gap-1">
          <Button variant="outline" size="xs" onClick={() => onEdit(recovery)}>{t("workbench.browserDraft")}</Button>
          {removeButton(recoveryId, title(recovery.form?.title ?? recovery.draft?.payload.title ?? recovery.title), false)}
        </div>
      </li> : null}
    </ul>
    {deleting ? <DeleteCalendarDraftDialog {...deleting} onOpenChange={open => { if (!open) setDeleting(null); }} onDeleted={() => onRecoveryChange(loadRecovery())} /> : null}
  </section>;
}
