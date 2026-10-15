import type { Suggestion, TaskSummary, Urgency } from "./types";

/**
 * Plain-language problems of a task, derived from the extractor's review reasons. The reasons are
 * internal codes ("ambiguous_date", "title_incomplete", …); the UI only ever shows these issues.
 */
export type IssueKind =
  | "date_conflict"
  | "duplicate"
  | "date_unclear"
  | "content_unclear"
  | "suspicious"
  | "not_in_source"
  | "marketing"
  | "ocr_quality"
  | "low_certainty"
  | "split";

export interface Issue {
  kind: IssueKind;
  /** "high" issues can change what the task is or when it is due. */
  severity: "high" | "medium" | "low";
  /** The internal reason codes behind the issue (shown only in the technical details). */
  reasons: string[];
}

const REASON_ISSUE: Record<string, IssueKind> = {
  date_conflict: "date_conflict",
  possible_duplicate: "duplicate",
  ambiguous_date: "date_unclear",
  date_needs_confirmation: "date_unclear",
  relative_date_without_source_date: "date_unclear",
  date_not_found_in_source: "date_unclear",
  title_incomplete: "content_unclear",
  possible_prompt_injection: "suspicious",
  evidence_not_found_in_source: "not_in_source",
  marketing_context: "marketing",
  low_ocr_confidence: "ocr_quality",
  low_confidence: "low_certainty",
  split_from_merge: "split",
};

const ISSUE_ORDER: IssueKind[] = [
  "date_conflict",
  "duplicate",
  "date_unclear",
  "content_unclear",
  "suspicious",
  "not_in_source",
  "marketing",
  "ocr_quality",
  "low_certainty",
  "split",
];

const SEVERITY: Record<IssueKind, Issue["severity"]> = {
  date_conflict: "high",
  duplicate: "high",
  date_unclear: "high",
  content_unclear: "medium",
  suspicious: "medium",
  not_in_source: "medium",
  marketing: "medium",
  ocr_quality: "low",
  low_certainty: "low",
  split: "low",
};

type IssueTask = Pick<TaskSummary, "review_reasons" | "needs_review" | "due_needs_confirmation" | "status">;

/**
 * Issues the user still has to look at. Once the user has reviewed a task (confirmed or edited it),
 * the extractor's doubts are no longer shown, except an unconfirmed date.
 */
export function taskIssues(task: IssueTask): Issue[] {
  const closed = task.status === "completed" || task.status === "dismissed";
  const byKind = new Map<IssueKind, string[]>();
  if (task.needs_review && !closed) {
    for (const reason of task.review_reasons) {
      const kind = REASON_ISSUE[reason];
      if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), reason]);
    }
  }
  if (task.due_needs_confirmation && !closed && !byKind.has("date_unclear") && !byKind.has("date_conflict")) {
    byKind.set("date_unclear", ["date_needs_confirmation"]);
  }
  return ISSUE_ORDER.filter((k) => byKind.has(k)).map((kind) => ({ kind, severity: SEVERITY[kind], reasons: byKind.get(kind) ?? [] }));
}

const URGENT: Urgency[] = ["overdue", "urgent", "high"];

/**
 * Handling priority for the review inbox (lower first). Not the extractor's confidence: what matters
 * is whether something is already late, how soon it is due and whether it has a problem that could
 * change the outcome (conflicting dates, possible duplicate, unclear date or content).
 *
 * 0 overdue · 1 due within 3 days · 2 serious problem or open suggestion · 3 due within 7 days ·
 * 4 other doubts · 5 later deadline · 6 no deadline.
 */
export function inboxGroup(task: TaskSummary): number {
  if (task.urgency === "overdue") return 0;
  if (URGENT.includes(task.urgency)) return 1;
  const issues = taskIssues(task);
  if (issues.some((i) => i.severity === "high") || task.pending_suggestions > 0) return 2;
  if (task.urgency === "upcoming") return 3;
  if (issues.length > 0) return 4;
  return task.due_date ? 5 : 6;
}

function time(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const t = Date.parse(value);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

export type InboxSort = "priority" | "due" | "detected";

function detectedAt(task: TaskSummary): number {
  return Date.parse(task.detected_at ?? task.created_at ?? "") || 0;
}

export function sortInbox(tasks: TaskSummary[], sort: InboxSort): TaskSummary[] {
  // Infinity - Infinity is NaN, so tasks without a deadline compare as equal (0) among themselves.
  const byDue = (a: TaskSummary, b: TaskSummary) => time(a.effective_deadline) - time(b.effective_deadline) || 0;
  const byDetected = (a: TaskSummary, b: TaskSummary) => detectedAt(b) - detectedAt(a) || a.id.localeCompare(b.id);
  const copy = [...tasks];
  if (sort === "detected") return copy.sort(byDetected);
  if (sort === "due") return copy.sort((a, b) => byDue(a, b) || byDetected(a, b));
  return copy.sort((a, b) => inboxGroup(a) - inboxGroup(b) || byDue(a, b) || byDetected(a, b));
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Fields of a suggestion payload that the UI understands. */
export function suggestionPayload(s: Suggestion) {
  return {
    dueDate: str(s.payload.due_date),
    dueTime: str(s.payload.due_time),
    dueText: str(s.payload.due_text),
    previousDueDate: str(s.payload.previous_due_date),
    otherTitle: str(s.payload.other_title) ?? s.related_task_title ?? null,
    otherTaskId: str(s.payload.other_task_id) ?? s.related_task_id,
  };
}

/** The extractor's reason string split into its parts ("action=0.80; text=0.41; …"), for the technical details. */
export function reasonParts(reason: string | null | undefined): string[] {
  return (reason ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
}

type DueFields = Pick<TaskSummary, "due_date" | "due_time">;

/** Two deadlines differ (the backend then needs an explicit choice before merging). */
export function deadlinesDiffer(incoming: DueFields, existing: DueFields): boolean {
  if (!incoming.due_date) return false;
  return incoming.due_date !== existing.due_date || (incoming.due_time ?? null) !== (existing.due_time ?? null);
}
