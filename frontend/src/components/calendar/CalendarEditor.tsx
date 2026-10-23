import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CloudUpload, Save, TriangleAlert } from "lucide-react";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogActions, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { conflictExclude, formAt, useConflicts } from "@/lib/buffers";
import { calendarApi, displayRange, eventDuration, eventForm, type CalendarDraft, type CalendarItem, type CalendarSources, type EventForm, type RemoteEvent } from "@/lib/calendar";
import { useUnsavedChanges } from "@/lib/desktop";
import { errorMessage } from "@/lib/errors";
import { refreshAll } from "@/lib/queries";
import { BufferFields } from "./BufferFields";
import { ConflictNotice } from "./ConflictNotice";

export const RECOVERY_KEY = "taskradar.calendar.editor";
export interface EditorSeed {
  mode: "local" | "google";
  id?: string;
  taskId?: string | null;
  title?: string;
  start?: string;
  item?: CalendarItem;
  draft?: CalendarDraft;
  form?: EventForm;
  calendarId?: string;
  publish?: boolean;
  operation?: "create" | "update" | "delete";
}
// eslint-disable-next-line react-refresh/only-export-components
export function loadRecovery(): EditorSeed | null {
  try { return JSON.parse(localStorage.getItem(RECOVERY_KEY) ?? "null") as EditorSeed | null; } catch { return null; }
}

export function CalendarEditor({ seed, sources, timezone, onClose }: {
  seed: EditorSeed; sources: CalendarSources; timezone: string; onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [id] = useState(() => seed.id ?? seed.draft?.id ?? crypto.randomUUID());
  const [form, setForm] = useState<EventForm>(() => seed.form ?? seed.draft?.payload ?? eventForm(seed.item, timezone, seed.start, seed.title));
  const [calendarId, setCalendarId] = useState(seed.calendarId ?? seed.draft?.calendar_id ?? seed.item?.calendar_id ?? sources.default_calendar_id ?? sources.sources.find((s) => s.writable)?.id ?? "");
  const [base, setBase] = useState<RemoteEvent | Record<string, never>>(seed.draft?.base_event ?? seed.item?.remote ?? {});
  const [conflict, setConflict] = useState<RemoteEvent | undefined>(seed.draft?.status === "conflict" ? seed.draft.remote_event : undefined);
  const [confirm, setConfirm] = useState(false);
  const [failed, setFailed] = useState("");
  const remote = seed.mode === "google";
  const [operation, setOperation] = useState(seed.operation ?? seed.draft?.operation ?? (seed.item?.event_id && !seed.publish ? "update" : "create"));
  const deleting = operation === "delete";
  const target = sources.sources.find((s) => s.id === calendarId);
  const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const draft: CalendarDraft = { id, operation, calendar_id: calendarId, event_id: operation === "create" ? null : seed.draft?.event_id ?? seed.item?.event_id ?? base.id,
    work_block_id: seed.draft?.work_block_id ?? seed.item?.work_block_id, payload: form, base_event: base, status: "draft" };
  useUnsavedChanges(true);

  useEffect(() => {
    // A service/network failure must not erase even incomplete form input or a local work plan.
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ ...seed, id, form, calendarId, draft: remote ? {
      id, operation, calendar_id: calendarId, event_id: operation === "create" ? null : seed.draft?.event_id ?? seed.item?.event_id ?? base.id,
      work_block_id: seed.draft?.work_block_id ?? seed.item?.work_block_id, payload: form, base_event: base,
      status: conflict ? "conflict" : "draft", remote_event: conflict,
    } : undefined }));
  }, [seed, id, form, calendarId, remote, base, conflict, operation]);

  const finish = () => { localStorage.removeItem(RECOVERY_KEY); void refreshAll(qc); onClose(); };
  const save = useMutation({
    mutationFn: async () => {
      if (!remote) return calendarApi.saveBlock(form, seed.taskId ?? seed.item?.task_id, seed.item);
      await calendarApi.saveDraft(draft);
      return calendarApi.commit(id);
    },
    onSuccess: () => { toast.success(t("workbench.saved")); finish(); },
    onError: (error) => {
      setConfirm(false); setFailed(errorMessage(error));
      if (error instanceof ApiError && error.code === "event_conflict") setConflict(error.details.remote as RemoteEvent | undefined);
      toast.error(errorMessage(error)); void refreshAll(qc);
    },
  });
  const keep = useMutation({
    mutationFn: async () => { if (remote && calendarId) await calendarApi.saveDraft(draft); },
    onSuccess: () => { void refreshAll(qc); onClose(); },
    onError: (e) => setFailed(errorMessage(e)),
  });
  const resolution = useMutation({
    mutationFn: (choice: "discard" | "rebase") => calendarApi.resolve(id, choice),
    onSuccess: (d, choice) => {
      if (choice === "discard") finish();
      else { setBase(d.base_event); setOperation(d.operation); setConflict(undefined); setFailed(""); }
    },
    onError: (e) => setFailed(errorMessage(e)),
  });
  const duration = eventDuration(form);
  const valid = !!form.title.trim() && !!form.start && !!form.end && duration > 0;
  // The overlap warning needs valid times only, not a title yet.
  const timed = !!form.start && !!form.end && duration > 0 && !form.all_day && !deleting;
  const conflicts = useConflicts(form, conflictExclude(seed.item, remote ? draft : undefined), timed);
  const title = deleting ? t("workbench.deleteEvent") : remote ? t("workbench.newEvent") : t("workbench.newBlock");
  const range = displayRange(form.start, form.end, form.all_day, form.timezone, i18n.language);
  return <Dialog open onOpenChange={(open) => { if (!open && !save.isPending) keep.mutate(); }}>
    <DialogContent className="sm:max-w-xl max-sm:pb-0" onInteractOutside={(e) => e.preventDefault()}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><CalendarClock className="size-5 text-primary" />{title}</DialogTitle>
        <DialogDescription>{remote ? t("workbench.draft") : t("workbench.keepDeadline")}</DialogDescription>
      </DialogHeader>
      <form id="calendar-editor" className="grid gap-3" onSubmit={(e) => {
        e.preventDefault(); setFailed("");
        if (!valid && !deleting) { setFailed(t("workbench.invalid")); return; }
        if (remote) setConfirm(true); else save.mutate();
      }}>
        {remote ? <Field label={t("workbench.target")} htmlFor="event-calendar">
          <select id="event-calendar" className="calendar-select" value={calendarId} disabled={operation !== "create"} onChange={(e) => setCalendarId(e.target.value)}>
            <option value="">{t("workbench.chooseCalendar")}</option>
            {sources.sources.filter((s) => s.writable || s.id === calendarId).map((s) => <option key={s.id} value={s.id}>{s.summary}{s.writable ? "" : ` · ${t("workbench.readOnly")}`}</option>)}
          </select>
        </Field> : null}
        <Field label={t("workbench.titleLabel")} htmlFor="event-title"><Input id="event-title" value={form.title} maxLength={200} required disabled={deleting} onChange={(e) => set("title", e.target.value)} /></Field>
        {!deleting ? <>
          {remote ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.all_day} onChange={(e) => {
            const on = e.target.checked;
            setForm((f) => ({ ...f, all_day: on, start: on ? f.start.slice(0, 10) : `${f.start}T09:00`, end: on ? (f.end.slice(0, 10) > f.start.slice(0, 10) ? f.end.slice(0, 10) : DateTime.fromISO(f.start.slice(0, 10)).plus({ days: 1 }).toISODate()!) : `${f.end}T10:00` }));
          }} />{t("workbench.allDay")}</label> : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("workbench.start")} htmlFor="event-start"><Input id="event-start" type={form.all_day ? "date" : "datetime-local"} required value={form.start} onChange={(e) => set("start", e.target.value)} /></Field>
            <Field label={t("workbench.end")} htmlFor="event-end"><Input id="event-end" type={form.all_day ? "date" : "datetime-local"} required value={form.end} onChange={(e) => set("end", e.target.value)} /></Field>
          </div>
          <p className="text-xs text-muted-foreground">{form.all_day ? t("workbench.endExclusive") : `${form.timezone} · ${t("workbench.duration", { minutes: Math.round(duration) || 0 })}`}</p>
          {!form.all_day ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("workbench.dst")}</summary><div className="mt-2 grid grid-cols-2 gap-2">
            {(["start", "end"] as const).map((key) => <Field key={key} label={t(key === "start" ? "workbench.startFold" : "workbench.endFold")} htmlFor={`fold-${key}`}>
              <select id={`fold-${key}`} className="calendar-select" value={form[`${key}_fold`] ?? ""} onChange={(e) => set(`${key}_fold`, e.target.value === "" ? null : Number(e.target.value) as 0 | 1)}>
                <option value="">{t("workbench.foldAuto")}</option><option value="0">{t("workbench.foldFirst")}</option><option value="1">{t("workbench.foldSecond")}</option>
              </select>
            </Field>)}
          </div></details> : null}
          {!form.all_day ? <BufferFields value={form.buffer} onChange={(buffer) => set("buffer", buffer)} /> : null}
          <ConflictNotice check={conflicts} enabled={timed} timezone={form.timezone} day={form.start.slice(0, 10)} onMove={(start, end) => setForm((f) => formAt(f, start, end))} />
          {remote ? <>
            <Field label={t("workbench.location")} htmlFor="event-location"><Input id="event-location" value={form.location} maxLength={1000} onChange={(e) => set("location", e.target.value)} /></Field>
            <Field label={t("workbench.description")} htmlFor="event-description"><Textarea id="event-description" value={form.description} maxLength={8000} rows={3} onChange={(e) => set("description", e.target.value)} /></Field>
          </> : null}
        </> : <p className="text-sm">{range}<br />{t("workbench.remoteDeletion")}</p>}
      </form>
      {failed ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">{t("workbench.unsaved")} {failed}</p> : null}
      {conflict ? <section className="grid gap-2 rounded-lg border border-high/50 bg-high/5 p-3 text-sm">
        <h3 className="flex items-center gap-2 font-semibold"><TriangleAlert className="size-4" />{t("workbench.conflict")}</h3>
        <p>{t("workbench.conflictHint")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div><strong>{t("workbench.mine")}</strong><p>{form.title}</p><p className="text-xs">{range}</p><p className="whitespace-pre-wrap">{form.description}</p></div>
          <div><strong>{t("workbench.remote")}</strong><p>{conflict.summary ?? conflict.status}</p><p className="text-xs">{conflict.start?.dateTime ?? conflict.start?.date} → {conflict.end?.dateTime ?? conflict.end?.date}</p><p className="whitespace-pre-wrap">{conflict.description}</p></div>
        </div>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => resolution.mutate("discard")}>{t("workbench.useRemote")}</Button>
          <Button size="sm" disabled={!conflict.etag || conflict.status === "cancelled" || resolution.isPending} onClick={() => resolution.mutate("rebase")}>{t("workbench.rebase")}</Button></div>
      </section> : null}
      {remote && !target?.writable ? <p className="text-sm text-high">{t("workbench.noWritable")}</p> : null}
      <DialogActions>
        <Button variant="outline" disabled={save.isPending} loading={keep.isPending} onClick={() => keep.mutate()}>{t("workbench.saveDraft")}</Button>
        <Button form="calendar-editor" type="submit" loading={save.isPending} disabled={!!conflict || (remote && !target?.writable)}>
          {remote ? <CloudUpload /> : <Save />}{remote ? t("workbench.review") : t("workbench.saveLocal")}
        </Button>
      </DialogActions>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={deleting ? t("workbench.confirmDelete") : t("workbench.confirmSave")}
        description={<div className="grid gap-2"><strong>{form.title}</strong><p>{t("workbench.target")}: {target?.summary}</p><p>{range}</p>{deleting ? <p>{t("workbench.remoteDeletion")}</p> : null}
          {timed && conflicts.data?.conflicts.length ? <p className="flex items-center gap-2 text-high"><TriangleAlert className="size-4 shrink-0" aria-hidden />{t("workbench.conflictConfirm", { count: conflicts.data.conflicts.length })}</p> : null}</div>}
        confirmLabel={t("workbench.submit")} cancelLabel={t("workbench.cancel")} destructive={deleting} pending={save.isPending} onConfirm={() => save.mutate()} />
    </DialogContent>
  </Dialog>;
}
