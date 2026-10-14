import type { TaskPatch } from "./api";
import type { Category, Priority, TaskDetail, TimeSemantics } from "./types";

export interface FormState {
  title: string;
  description: string;
  action_required: string;
  category: Category;
  priority: Priority;
  due_date: string;
  due_time: string;
  time_semantics: TimeSemantics;
}

export function initialState(task?: TaskDetail): FormState {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    action_required: task?.action_required ?? "",
    category: task?.category ?? "other",
    priority: task?.priority ?? "medium",
    due_date: task?.due_date ?? "",
    due_time: task?.due_time ?? "",
    time_semantics: task?.time_semantics ?? "deadline",
  };
}

/** Only the fields the user actually changed are sent, so untouched fields stay agent-managed. */
export function diffPatch(task: TaskDetail, form: FormState): TaskPatch {
  const patch: TaskPatch = {};
  if (form.title.trim() !== task.title) patch.title = form.title.trim();
  if (form.description !== task.description) patch.description = form.description;
  if (form.action_required !== task.action_required) patch.action_required = form.action_required;
  if (form.category !== task.category) patch.category = form.category;
  if (form.priority !== task.priority) patch.priority = form.priority;
  if (form.time_semantics !== task.time_semantics) patch.time_semantics = form.time_semantics;
  if (!form.due_date && task.due_date) {
    patch.clear_due = true;
  } else {
    if (form.due_date && form.due_date !== task.due_date) patch.due_date = form.due_date;
    if ((form.due_time || null) !== (task.due_time || null)) patch.due_time = form.due_time || null;
    if (patch.due_time && !patch.due_date && form.due_date) patch.due_date = form.due_date;
  }
  return patch;
}
