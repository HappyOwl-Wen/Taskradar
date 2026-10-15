import type { Suggestion, TaskDetail, TaskSummary } from "@/lib/types";

/** A synthetic task summary; override only what a test cares about. */
export function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "t1",
    title: "Synthetic task",
    category: "other",
    action_type: "other",
    status: "candidate",
    priority: "medium",
    confidence: 0.8,
    due_at: null,
    due_date: null,
    due_time: null,
    due_precision: "none",
    due_text: null,
    due_is_relative: false,
    due_needs_confirmation: false,
    time_semantics: "deadline",
    timezone: "Europe/Berlin",
    urgency: "no_deadline",
    effective_deadline: null,
    remaining_seconds: null,
    needs_review: false,
    review_reasons: [],
    source_count: 0,
    source_kinds: [],
    pending_suggestions: 0,
    calendar_status: null,
    detected_at: "2026-10-14T08:00:00+00:00",
    source_published_at: null,
    source_published_day: null,
    created_at: "2026-10-14T08:00:00+00:00",
    updated_at: "2026-10-14T08:00:00+00:00",
    confirmed_at: null,
    completed_at: null,
    manual: false,
    ...overrides,
  };
}

export function makeDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...makeTask(),
    description: "",
    action_required: "",
    entities: [],
    user_locked_fields: [],
    due_anchor: null,
    due_version: 1,
    sources: [],
    events: [],
    suggestions: [],
    calendar: null,
    links: [],
    ...overrides,
  };
}

export function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: 5,
    task_id: "new",
    kind: "possible_duplicate",
    payload: { other_task_id: "old", other_title: "Miete November überweisen", score: 0.71 },
    evidence: [],
    confidence: 0.71,
    reason: "entities=None; action=1.00; text=0.52; grey_zone_needs_user_decision",
    status: "pending",
    created_at: "2026-10-14T08:00:00+00:00",
    related_task_id: "old",
    task_title: "Mietzahlung November",
    ...overrides,
  };
}
