import { ChevronRight, Quote } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { SimpleSelect } from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { markJustAdded } from "@/lib/justAdded";
import { useAction } from "@/lib/queries";
import { diffPatch, initialState, type FormState } from "@/lib/task-form";
import { CATEGORIES, PRIORITIES, type Category, type Priority, type QuickParse, type TaskDetail, type TimeSemantics } from "@/lib/types";
import { cn } from "@/lib/utils";

/** "edit": change fields and save; "confirm": the candidate is confirmed together with the changes. */
export type EditIntent = "edit" | "confirm";
/** The field the dialog starts in (a "fix the date" button opens it at the date). */
export type EditFocus = "title" | "date";

export function TaskEditDialog({
  open,
  onOpenChange,
  task,
  intent = "edit",
  focus = "title",
  context,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent → add a new (manual, confirmed) to-do. */
  task?: TaskDetail;
  intent?: EditIntent;
  focus?: EditFocus;
  /** The source's own wording, shown above the fields when the dialog is opened to fix one of them. */
  context?: string | null;
  onSaved?: (task: TaskDetail) => void;
}) {
  const { t } = useTranslation();
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Escape, the close button, a click outside and "Cancel" all ask first when something was typed.
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onOpenChange(false));
  // The form is mounted only while the dialog is open, so it always starts from the current task.
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}>
        <DialogContent className="max-sm:pb-0 sm:max-w-xl">
          {task ? (
            <EditForm task={task} intent={intent} focus={focus} context={context} onCancel={requestClose} onClose={() => onOpenChange(false)} onSaved={onSaved} onDirtyChange={setDirty} />
          ) : (
            <AddForm onCancel={requestClose} onClose={() => onOpenChange(false)} onSaved={onSaved} onDirtyChange={setDirty} />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t("detail.discardTitle")}
        description={t("detail.discardDescription")}
        confirmLabel={t("settings.discard")}
        cancelLabel={t("settings.keepEditing")}
        destructive
        onConfirm={() => {
          setConfirmDiscard(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}

/**
 * Buttons at the end of the form; on phones they stay in view at the bottom of the dialog. The dialog's
 * bottom padding moves into the bar there, because a sticky element stops at the padding edge.
 */
function FormFooter({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-6 grid grid-cols-2 gap-2 border-t bg-card px-6 pt-3 pb-6 max-sm:[&_button]:h-11 sm:static sm:mx-0 sm:flex sm:justify-end sm:border-t-0 sm:bg-transparent sm:p-0">
      {children}
    </div>
  );
}

/** Rarely needed fields, collapsed so that the common case is one line and a date. */
function MoreOptions({ children, defaultOpen = false }: { children: ReactNode; defaultOpen?: boolean }) {
  const { t } = useTranslation();
  return (
    <details open={defaultOpen} className="group/more">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-sm font-medium text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open/more:rotate-90" aria-hidden />
        {t("form.more")}
      </summary>
      <div className="mt-3 grid gap-4">{children}</div>
    </details>
  );
}

function DateFields({
  date,
  time,
  onDate,
  onTime,
  autoFocus = false,
  onClear,
}: {
  date: string;
  time: string;
  onDate: (value: string) => void;
  onTime: (value: string) => void;
  autoFocus?: boolean;
  onClear?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-3">
        <Field label={t("field.due_date")} htmlFor="task-date">
          <Input id="task-date" type="date" value={date} autoFocus={autoFocus} onChange={(e) => onDate(e.target.value)} />
        </Field>
        <Field label={t("field.due_time")} htmlFor="task-time">
          <Input id="task-time" type="time" value={time} disabled={!date} onChange={(e) => onTime(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-xs text-muted-foreground">{t("detail.timeHint")}</p>
        {date && onClear ? (
          <Button type="button" variant="link" size="xs" className="h-auto px-0" onClick={onClear}>
            {t("form.noDue")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function KindField({ value, onChange }: { value: TimeSemantics; onChange: (value: TimeSemantics) => void }) {
  const { t } = useTranslation();
  return (
    <Field label={t("form.kindLabel")} htmlFor="task-semantics">
      <SimpleSelect
        id="task-semantics"
        value={value}
        onValueChange={(v) => onChange(v)}
        options={(["deadline", "appointment"] as const).map((s) => ({ value: s, label: t(`form.kind.${s}`) }))}
      />
    </Field>
  );
}

function CategoryPriority({
  category,
  priority,
  onCategory,
  onPriority,
}: {
  category: Category;
  priority: Priority;
  onCategory: (value: Category) => void;
  onPriority: (value: Priority) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t("field.category")} htmlFor="task-category">
        <SimpleSelect id="task-category" value={category} onValueChange={onCategory} options={CATEGORIES.map((c) => ({ value: c, label: t(`category.${c}`) }))} />
      </Field>
      <Field label={t("field.priority")} htmlFor="task-priority">
        <SimpleSelect id="task-priority" value={priority} onValueChange={onPriority} options={PRIORITIES.map((p) => ({ value: p, label: t(`priority.${p}`) }))} />
      </Field>
    </div>
  );
}

/**
 * A new to-do in one sentence ("周五前交房租"): the server recognises title, date and time while typing,
 * the recognised date stays editable, and everything else is optional and collapsed.
 */
function AddForm({
  onCancel,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  onCancel: () => void;
  onClose: () => void;
  onSaved?: (task: TaskDetail) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<{ text: string; result: QuickParse } | null>(null);
  // Values the user set by hand win over what is recognised from the sentence.
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const [dateOverride, setDateOverride] = useState<{ date: string; time: string } | null>(null);
  const [kindOverride, setKindOverride] = useState<TimeSemantics | null>(null);
  const [categoryOverride, setCategoryOverride] = useState<Category | null>(null);
  const [priority, setPriority] = useState<Priority>("medium");
  const [description, setDescription] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(0);

  const result = parsed && parsed.text === text.trim() ? parsed.result : null;
  const recognisedTitle = result?.title.trim() || text.trim();
  const title = (titleOverride ?? recognisedTitle).trim();
  const date = dateOverride ? dateOverride.date : (result?.due_date ?? "");
  const time = dateOverride ? dateOverride.time : (result?.due_time ?? "");
  const kind = kindOverride ?? result?.time_semantics ?? "deadline";
  const category = categoryOverride ?? (result && result.category !== "other" ? result.category : "other");

  const dirty = Boolean(text.trim() || (titleOverride ?? "").trim() || description.trim() || dateOverride?.date);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const parseNow = async (value: string): Promise<QuickParse | null> => {
    const request = ++latest.current;
    try {
      const r = await api.quickParse(value);
      if (request === latest.current) setParsed({ text: value, result: r });
      return r;
    } catch {
      return null; // only a convenience: the sentence itself is saved
    }
  };
  const onText = (value: string) => {
    setText(value);
    window.clearTimeout(timer.current);
    const trimmed = value.trim();
    if (!trimmed) {
      latest.current += 1;
      return;
    }
    timer.current = window.setTimeout(() => void parseNow(trimmed), 250);
  };

  const save = useAction(
    async (): Promise<TaskDetail> => {
      // Enter right after typing: wait for the recognition of the final sentence instead of saving it raw.
      const sentence = text.trim();
      const r = result ?? (sentence ? await parseNow(sentence) : null);
      const finalTitle = (titleOverride ?? (r?.title.trim() || sentence)).trim();
      const dueDate = dateOverride ? dateOverride.date : (r?.due_date ?? "");
      const dueTime = dateOverride ? dateOverride.time : (r?.due_time ?? "");
      return api.createTask({
        title: finalTitle,
        description,
        action_required: "",
        category: categoryOverride ?? (r && r.category !== "other" ? r.category : "other"),
        priority,
        due_date: dueDate || null,
        due_time: dueDate && dueTime ? dueTime : null,
        time_semantics: kindOverride ?? r?.time_semantics ?? "deadline",
        action_type: r?.action_type ?? "other",
        // Keep the user's own wording of the date only while the date is still the recognised one.
        due_text: r?.due_date && r.due_date === dueDate ? r.due_text : null,
      });
    },
    {
      onSuccess: (created) => {
        markJustAdded(created.id);
        toast.success(t("tasks.created"), {
          action: { label: t("common.view"), onClick: () => navigate(`/tasks/${created.id}`, { state: { justAdded: true } }) },
        });
        onClose();
        onSaved?.(created);
      },
    },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title && !text.trim()) return;
    save.mutate(undefined);
  };
  const when = date ? `${formatDate(date, i18n.language)}${time ? ` ${time}` : ""}` : null;

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("newTask.title")}</DialogTitle>
        <DialogDescription>{t("newTask.description")}</DialogDescription>
      </DialogHeader>
      <Field label={t("newTask.quickLabel")} htmlFor="task-quick">
        <Input id="task-quick" value={text} maxLength={300} placeholder={t("newTask.quickPlaceholder")} autoFocus onChange={(e) => onText(e.target.value)} />
      </Field>
      <p className="-mt-2 text-xs leading-relaxed text-muted-foreground" aria-live="polite">
        {text.trim() && title
          ? when
            ? t("newTask.previewWithDate", { title, when })
            : t("newTask.preview", { title })
          : t("newTask.quickHint")}
      </p>
      {result?.ambiguous ? (
        <p className="-mt-2 text-xs text-urgent">{t("newTask.ambiguous", { alternatives: result.alternatives.map((d) => formatDate(d, i18n.language)).join(", ") })}</p>
      ) : null}
      <DateFields
        date={date}
        time={time}
        onDate={(value) => setDateOverride({ date: value, time: value ? time : "" })}
        onTime={(value) => setDateOverride({ date, time: value })}
        onClear={() => setDateOverride({ date: "", time: "" })}
      />
      <MoreOptions>
        <Field label={t("form.savedTitle")} htmlFor="task-title">
          <Input id="task-title" value={titleOverride ?? recognisedTitle} maxLength={200} onChange={(e) => setTitleOverride(e.target.value)} />
        </Field>
        {date && time ? <KindField value={kind} onChange={setKindOverride} /> : null}
        <CategoryPriority category={category} priority={priority} onCategory={setCategoryOverride} onPriority={setPriority} />
        <Field label={t("field.description")} htmlFor="task-description">
          <Textarea id="task-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </MoreOptions>
      <FormFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={save.isPending}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending || !text.trim()}>
          {save.isPending ? t("common.saving") : t("newTask.submit")}
        </Button>
      </FormFooter>
    </form>
  );
}

/**
 * Editing an existing task: title and deadline first, the rest collapsed. Opened from "edit and confirm",
 * the main button saves and confirms in one step; "save changes only" stays available.
 */
function EditForm({
  task,
  intent,
  focus,
  context,
  onCancel,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  task: TaskDetail;
  intent: EditIntent;
  focus: EditFocus;
  context?: string | null;
  onCancel: () => void;
  onClose: () => void;
  onSaved?: (task: TaskDetail) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(() => initialState(task));
  const dirty = Object.keys(diffPatch(task, form)).length > 0;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const confirming = intent === "confirm" && task.status === "candidate";

  const save = useAction(
    async ({ confirm }: { confirm: boolean }) => {
      const patch = diffPatch(task, form);
      let updated: TaskDetail = task;
      if (Object.keys(patch).length > 0) updated = await api.updateTask(task.id, patch);
      if (confirm) updated = await api.setStatus(task.id, "confirmed");
      return { task: updated, confirmed: confirm };
    },
    {
      success: (r) => (r.confirmed ? t("detail.savedAndConfirmed") : t("common.saved")),
      // Undo takes back the confirmation; the edits stay (they are in the history and can be undone there).
      undo: (r) => (r.confirmed ? r.task.undo_event_id : undefined),
      onSuccess: (r) => {
        onClose();
        onSaved?.(r.task);
      },
    },
  );

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    save.mutate({ confirm: confirming });
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{confirming ? t("detail.confirmEditTitle") : t("detail.edit")}</DialogTitle>
        {confirming ? <DialogDescription>{t("detail.confirmEditDescription")}</DialogDescription> : null}
      </DialogHeader>
      {context ? (
        <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-[13px] leading-relaxed break-words">
          <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0">
            <span className="text-muted-foreground">{t("due.original")}: </span>“{context}”
          </span>
        </p>
      ) : null}
      <Field label={t("field.title")} htmlFor="task-title">
        <Input id="task-title" value={form.title} maxLength={200} required onChange={(e) => set("title", e.target.value)} autoFocus={focus === "title"} />
      </Field>
      <DateFields
        date={form.due_date}
        time={form.due_time}
        autoFocus={focus === "date"}
        onDate={(value) => setForm((f) => ({ ...f, due_date: value, due_time: value ? f.due_time : "" }))}
        onTime={(value) => set("due_time", value)}
        onClear={() => setForm((f) => ({ ...f, due_date: "", due_time: "" }))}
      />
      <MoreOptions>
        {form.due_date && form.due_time ? <KindField value={form.time_semantics} onChange={(v) => set("time_semantics", v)} /> : null}
        <Field label={t("field.action_required")} htmlFor="task-action">
          <Textarea id="task-action" rows={2} value={form.action_required} onChange={(e) => set("action_required", e.target.value)} />
        </Field>
        <Field label={t("field.description")} htmlFor="task-description">
          <Textarea id="task-description" rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <CategoryPriority category={form.category} priority={form.priority} onCategory={(v) => set("category", v)} onPriority={(v) => set("priority", v)} />
      </MoreOptions>
      <FormFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={save.isPending} className={cn(confirming && "max-sm:order-2")}>
          {t("common.cancel")}
        </Button>
        {confirming ? (
          <Button type="button" variant="outline" onClick={() => form.title.trim() && save.mutate({ confirm: false })} disabled={save.isPending || !dirty} className="max-sm:order-3">
            {t("detail.saveOnly")}
          </Button>
        ) : null}
        <Button type="submit" disabled={save.isPending || !form.title.trim()} className={cn(confirming && "max-sm:order-1 max-sm:col-span-2")}>
          {save.isPending ? t("common.saving") : confirming ? t("detail.saveAndConfirm") : t("common.save")}
        </Button>
      </FormFooter>
    </form>
  );
}
