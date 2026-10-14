import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Label, Textarea } from "@/components/ui/form";
import { SimpleSelect } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAction } from "@/lib/queries";
import { diffPatch, initialState, type FormState } from "@/lib/task-form";
import { CATEGORIES, PRIORITIES, type TaskDetail } from "@/lib/types";

export function TaskEditDialog({
  open,
  onOpenChange,
  task,
  offerConfirm = false,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent → create a new (manual, confirmed) task. */
  task?: TaskDetail;
  /** Show "save & confirm" for candidates. */
  offerConfirm?: boolean;
  onSaved?: (task: TaskDetail) => void;
}) {
  // The form is mounted only while the dialog is open, so it always starts from the current task.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <TaskEditForm task={task} offerConfirm={offerConfirm} onClose={() => onOpenChange(false)} onSaved={onSaved} />
      </DialogContent>
    </Dialog>
  );
}

function TaskEditForm({
  task,
  offerConfirm,
  onClose,
  onSaved,
}: {
  task?: TaskDetail;
  offerConfirm: boolean;
  onClose: () => void;
  onSaved?: (task: TaskDetail) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(() => initialState(task));
  const [confirmAfter, setConfirmAfter] = useState(false);

  const save = useAction(
    async ({ confirm }: { confirm: boolean }): Promise<TaskDetail> => {
      if (!task) {
        return api.createTask({
          title: form.title.trim(),
          description: form.description,
          action_required: form.action_required,
          category: form.category,
          priority: form.priority,
          due_date: form.due_date || null,
          due_time: form.due_date && form.due_time ? form.due_time : null,
          time_semantics: form.time_semantics,
        });
      }
      const patch = diffPatch(task, form);
      let updated = task;
      if (Object.keys(patch).length > 0) updated = await api.updateTask(task.id, patch);
      if (confirm) updated = await api.setStatus(task.id, "confirmed");
      return updated;
    },
    {
      success: () => (task ? t("common.saved") : t("tasks.created")),
      onSuccess: (updated) => {
        onClose();
        onSaved?.(updated);
      },
    },
  );

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    save.mutate({ confirm: confirmAfter });
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{task ? t("detail.edit") : t("newTask.title")}</DialogTitle>
        {task ? null : <DialogDescription>{t("newTask.description")}</DialogDescription>}
      </DialogHeader>
      <Field label={t("field.title")} htmlFor="task-title">
        <Input id="task-title" value={form.title} maxLength={200} required onChange={(e) => set("title", e.target.value)} autoFocus />
      </Field>
      <Field label={t("field.action_required")} htmlFor="task-action">
        <Textarea id="task-action" rows={2} value={form.action_required} onChange={(e) => set("action_required", e.target.value)} />
      </Field>
      <Field label={t("field.description")} htmlFor="task-description">
        <Textarea id="task-description" rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("field.category")} htmlFor="task-category">
          <SimpleSelect
            id="task-category"
            value={form.category}
            onValueChange={(v) => set("category", v)}
            options={CATEGORIES.map((c) => ({ value: c, label: t(`category.${c}`) }))}
          />
        </Field>
        <Field label={t("field.priority")} htmlFor="task-priority">
          <SimpleSelect
            id="task-priority"
            value={form.priority}
            onValueChange={(v) => set("priority", v)}
            options={PRIORITIES.map((p) => ({ value: p, label: t(`priority.${p}`) }))}
          />
        </Field>
      </div>
      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">{t("field.due")}</legend>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_1fr]">
          <Field label={t("field.due_date")} htmlFor="task-date">
            <Input id="task-date" type="date" value={form.due_date} onChange={(e) => set("due_date", e.target.value)} />
          </Field>
          <Field label={t("field.due_time")} htmlFor="task-time">
            <Input id="task-time" type="time" value={form.due_time} disabled={!form.due_date} onChange={(e) => set("due_time", e.target.value)} />
          </Field>
          <Field label={t("field.time_semantics")} htmlFor="task-semantics">
            <SimpleSelect
              id="task-semantics"
              value={form.time_semantics}
              onValueChange={(v) => set("time_semantics", v)}
              options={(["deadline", "appointment"] as const).map((s) => ({ value: s, label: t(`semantics.${s}`) }))}
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">{t("detail.timeHint")}</p>
        {task?.due_date ? (
          <Button type="button" variant="link" size="xs" className="w-fit px-0" onClick={() => setForm((f) => ({ ...f, due_date: "", due_time: "" }))}>
            {t("detail.clearDue")}
          </Button>
        ) : null}
      </fieldset>
      {task && offerConfirm ? (
        <Label className="font-normal">
          <Checkbox checked={confirmAfter} onCheckedChange={(v) => setConfirmAfter(v === true)} />
          {t("detail.saveAndConfirm")}
        </Label>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending || !form.title.trim()}>
          {save.isPending ? t("common.saving") : confirmAfter ? t("detail.saveAndConfirm") : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
