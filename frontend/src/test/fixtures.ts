import type { Dashboard, TaskDetail, TaskSummary, TimersOverview, TimerView } from "@/lib/types";

/** A synthetic task summary; override only what a test cares about. */
export function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "t1",
    title: "Synthetic task",
    category: "other",
    action_type: "other",
    status: "confirmed",
    priority: "medium",
    confidence: 1,
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
    calendar_status: null,
    detected_at: "2026-10-14T08:00:00+00:00",
    source_published_at: null,
    source_published_day: null,
    created_at: "2026-10-14T08:00:00+00:00",
    updated_at: "2026-10-14T08:00:00+00:00",
    confirmed_at: "2026-10-14T08:00:00+00:00",
    completed_at: null,
    manual: true,
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
    calendar: null,
    links: [],
    ...overrides,
  };
}

/** A home page with nothing in it; tests add the tasks they need. */
export function makeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    today: "2026-10-14",
    counts: {
      overdue: 0,
      due_today: 0,
      due_tomorrow: 0,
      due_soon: 0,
      active: 0,
      todo: 0,
      in_progress: 0,
      waiting_for_reply: 0,
      unconfirmed: 0,
      completed_7d: 0,
      sample_open: 0,
    },
    attention: [],
    attention_total: 0,
    lanes: { todo: [], in_progress: [], waiting_for_reply: [] },
    completed_recent: [],
    notifications_unread: 0,
    ...overrides,
  };
}

/** A running 25-minute focus session; override what a test needs (a countdown: kind "countdown", phase null). */
export function makeTimer(overrides: Partial<TimerView> = {}): TimerView {
  return {
    id: 1,
    kind: "pomodoro",
    phase: "focus",
    mode: "duration",
    label: "",
    task_id: null,
    task_title: null,
    cycle: 1,
    status: "running",
    duration_seconds: 1500,
    remaining_seconds: 1500,
    ends_at: "2026-10-14T08:25:00+00:00",
    started_at: "2026-10-14T08:00:00+00:00",
    finished_at: null,
    ...overrides,
  };
}

/** No timer running; the next start is the first focus session of a set. */
export function makeTimers(overrides: { pomodoro?: Partial<TimersOverview["pomodoro"]>; countdowns?: TimerView[] } = {}): TimersOverview {
  return {
    now: "2026-10-14T08:00:00+00:00",
    pomodoro: {
      current: null,
      last: null,
      next: { phase: "focus", cycle: 1, duration_seconds: 1500 },
      long_break_every: 4,
      today: { focus_sessions: 0, focus_minutes: 0 },
      ...overrides.pomodoro,
    },
    countdowns: overrides.countdowns ?? [],
  };
}
