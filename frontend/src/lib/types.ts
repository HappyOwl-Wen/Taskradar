// Mirrors the payloads produced by backend/src/taskradar/api/serializers.py

export type TaskStatus = "candidate" | "confirmed" | "in_progress" | "waiting_for_reply" | "completed" | "dismissed";
export type Category = "academic" | "administrative" | "financial" | "travel" | "personal" | "other";
export type Priority = "low" | "medium" | "high";
export type Urgency = "overdue" | "urgent" | "high" | "upcoming" | "normal" | "no_deadline" | "inactive";
export type DuePrecision = "none" | "date" | "datetime";
export type TimeSemantics = "deadline" | "appointment";

/**
 * The statuses the user chooses from. "candidate" (unconfirmed) only exists on tasks that earlier versions found in
 * mails and files; it is shown on such tasks but never offered as a choice.
 */
export const TASK_STATUSES: TaskStatus[] = ["confirmed", "in_progress", "waiting_for_reply", "completed", "dismissed"];
export const OPEN_STATUSES: TaskStatus[] = ["candidate", "confirmed", "in_progress", "waiting_for_reply"];
export const CATEGORIES: Category[] = ["academic", "administrative", "financial", "travel", "personal", "other"];
export const PRIORITIES: Priority[] = ["high", "medium", "low"];
export const URGENCIES: Urgency[] = ["overdue", "urgent", "high", "upcoming", "normal", "no_deadline"];

export interface TaskSummary {
  id: string;
  title: string;
  category: Category;
  action_type: string;
  status: TaskStatus;
  priority: Priority;
  confidence: number;
  due_at: string | null;
  due_date: string | null;
  due_time: string | null;
  due_precision: DuePrecision;
  due_text: string | null;
  due_is_relative: boolean;
  due_needs_confirmation: boolean;
  time_semantics: TimeSemantics;
  timezone: string;
  urgency: Urgency;
  effective_deadline: string | null;
  remaining_seconds: number | null;
  needs_review: boolean;
  review_reasons: string[];
  source_count: number;
  /** "manual" for the user's own to-dos, else the kind of mail or file an earlier version found the task in. */
  source_kinds: string[];
  calendar_status: string | null;
  detected_at: string | null;
  source_published_at: string | null;
  /** Set when the source only has a calendar date (no time of day). */
  source_published_day: string | null;
  created_at: string | null;
  updated_at: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  manual: boolean;
  /** Test data: marked, but never counted, reminded or written to the calendar. */
  sample?: boolean;
}

export interface Evidence {
  quote: string;
  page: number | null;
  start: number | null;
  end: number | null;
  verified: boolean;
  kind: "action" | "deadline" | "completion" | "context";
}

export interface TrashedTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  category: Category;
  due_date: string | null;
  due_time: string | null;
  deleted_at: string;
  expires_at: string;
  days_remaining: number;
}

export interface TaskTrash {
  items: TrashedTask[];
  total: number;
  retention_days: number;
}

/** A mail an earlier version imported (kept until the user deletes the imported content). */
export interface MessageBrief {
  id: number;
  subject: string;
  sender: string;
  sent_at: string | null;
  web_link: string | null;
  source_kind: string | null;
  status: string;
  thread_id: string | null;
}

/** A file an earlier version imported. */
export interface DocumentBrief {
  id: number;
  name: string;
  kind: "pdf" | "image";
  mime_type: string;
  size_bytes: number;
  page_count: number | null;
  doc_date: string | null;
  imported_at: string | null;
  source_kind: string | null;
  original_path: string | null;
  has_stored_copy: boolean;
  message_id: number | null;
}

/** Where an earlier version found a task: the mail or file (null once deleted), with the quoted sentences. */
export interface TaskSourceEntry {
  id: number;
  relation: "origin" | "duplicate" | "deadline_update" | "completion_evidence" | "related" | "manual_merge";
  origin_key: string;
  label: string;
  source_date: string | null;
  /** Set when the source only has a calendar date (no time of day). */
  source_day: string | null;
  evidence: Evidence[];
  created_at: string | null;
  message: MessageBrief | null;
  document: DocumentBrief | null;
}

export interface TaskEvent {
  id: number;
  type: string;
  actor: "user" | "agent" | "system";
  summary: string;
  reason: string | null;
  created_at: string | null;
  revertible: boolean;
  reverted: boolean;
  data: Record<string, unknown>;
}

export interface CalendarLink {
  calendar_id: string;
  event_id: string;
  event_kind: string;
  status: "synced" | "failed" | "out_of_sync" | "removed" | string;
  html_link: string | null;
  last_error: string | null;
  attempts: number;
  last_synced_at: string | null;
  synced_due_version: number;
}

/** What one sentence ("周五前交房租") was recognised as; nothing is saved yet. */
export interface QuickParse {
  title: string;
  category: Category;
  action_type: string;
  due_date: string | null;
  due_time: string | null;
  due_text: string | null;
  time_semantics: "deadline" | "appointment";
  ambiguous: boolean;
  alternatives: string[];
  timezone?: string;
  temporal?: TemporalParse;
}

export interface TemporalCandidate {
  normalized_date: string | null;
  normalized_time: string | null;
  range_start: string | null;
  range_end: string | null;
  original_expression: string;
  start: number;
  end: number;
  role: string;
  confidence: number;
  explanation: string[];
  selectable: boolean;
}

export interface TemporalParse {
  status: "absent" | "resolved" | "inferred" | "unresolved" | "urgency";
  precision: "none" | "date" | "datetime" | "range" | "time" | "period";
  normalized_date: string | null;
  normalized_time: string | null;
  original_expression: string | null;
  confidence: number;
  needs_confirmation: boolean;
  explanation: string[];
  candidates: TemporalCandidate[];
}

export interface TaskLinkEntry {
  kind: string;
  task_id: string;
  title: string;
  status: TaskStatus;
  direction: "outgoing" | "incoming";
}

export interface TaskDetail extends TaskSummary {
  description: string;
  action_required: string;
  entities: string[];
  user_locked_fields: string[];
  due_anchor: string | null;
  due_version: number;
  sources: TaskSourceEntry[];
  events: TaskEvent[];
  calendar: CalendarLink | null;
  links: TaskLinkEntry[];
  /** The change just made (status, test data), for an "undo" button. */
  undo_event_id?: number | null;
  calendar_warning?: string;
}

/** How soon an open task is due: the order of "needs attention" on the home page. */
export type AttentionReason = "overdue" | "due_today" | "due_tomorrow" | "due_soon";

export interface AttentionTask extends TaskSummary {
  attention: AttentionReason;
}

/** The three lanes of the home page's board. */
export type Lane = "todo" | "in_progress" | "waiting_for_reply";
export const LANES: Lane[] = ["todo", "in_progress", "waiting_for_reply"];

export interface Dashboard {
  today: string;
  counts: {
    overdue: number;
    due_today: number;
    due_tomorrow: number;
    due_soon: number;
    /** Open tasks (not test data). */
    active: number;
    todo: number;
    in_progress: number;
    waiting_for_reply: number;
    /** Unconfirmed tasks of earlier versions (part of "to do"). */
    unconfirmed: number;
    completed_7d: number;
    /** Open test data (not counted anywhere else). */
    sample_open: number;
  };
  attention: AttentionTask[];
  attention_total: number;
  /** The first few tasks of each lane (the counts say how many there are). */
  lanes: Record<Lane, TaskSummary[]>;
  completed_recent: TaskSummary[];
  notifications_unread: number;
}

export interface NotificationItem {
  id: number;
  task_id: string | null;
  level: "overdue" | "urgent" | "high" | "upcoming" | "info" | "error";
  title: string;
  body: string;
  created_at: string;
  read: boolean;
}

export interface Settings {
  general: { timezone: string; language: "zh-CN" | "en"; theme: "system" | "light" | "dark"; close_to_tray: boolean };
  reminders: {
    urgent_hours: number;
    high_days: number;
    upcoming_days: number;
    notify_candidates: boolean;
    notify_upcoming: boolean;
    overdue_repeat_hours: number;
    scan_interval_minutes: number;
  };
  notifications: { desktop_enabled: boolean; max_per_scan: number };
  calendar: {
    calendar_name: string;
    auto_sync_enabled: boolean;
    auto_sync_categories: Category[];
    reminder_minutes: number;
    remove_on_dismiss: boolean;
  };
  timers: {
    focus_minutes: number;
    short_break_minutes: number;
    long_break_minutes: number;
    long_break_every: number;
    auto_start_breaks: boolean;
    auto_start_focus: boolean;
    alarm_sound: boolean;
    notify: boolean;
  };
}

export interface SystemStatus {
  version: string;
  /** Running as TaskRadar.exe (not from the project folder). */
  packaged?: boolean;
  data_dir: string;
  secret_store: { backend: string; available: boolean };
  scheduler: { running: boolean; jobs: { id: string; next_run_time: string | null }[] };
  google: { client_configured: boolean; calendar_connected: boolean };
  autostart: { supported: boolean; enabled: boolean };
  /** TaskRadar in the Start menu: Windows shows its notifications as banners only with this entry. */
  start_menu?: { supported: boolean; present: boolean; banners: boolean; ours: boolean };
  desktop_notifications_supported: boolean;
  now: string;
}

export type StatusLevel = "error" | "warning" | "info";

/** Where a status item can be fixed: the calendar or notification settings, or the task list. */
export type StatusAction = "calendar" | "notifications" | "tasks";

/** One runtime problem in plain terms (the UI translates `code` with `params`). */
export interface StatusItem {
  code: string;
  level: StatusLevel;
  area: string;
  params: Record<string, unknown>;
  since: string | null;
  action: StatusAction | null;
}

export interface SystemSummary {
  overall: "ok" | "attention" | "problem";
  checked_at: string;
  items: StatusItem[];
}

export interface GoogleStatus {
  client: { configured: boolean; client_id_hint?: string };
  redirect_uri: string;
  calendar: { connected: boolean; calendar_id: string | null; calendar_name: string; scopes: string[]; read?: boolean; edit?: boolean; app?: boolean };
  /** How the last authorization ended (``seq`` grows with each one); null before the first. */
  last_authorization?: { seq: number; service: "calendar" | null; ok: boolean; error: string | null } | null;
}

export interface CalendarPreview {
  event: {
    summary: string;
    description: string;
    start: { date?: string; dateTime?: string; timeZone?: string };
    end: { date?: string; dateTime?: string; timeZone?: string };
    transparency: string;
    reminders: { overrides: { method: string; minutes: number }[] };
  };
  event_kind: string;
  calendar_name: string;
  connected: boolean;
  already_synced: boolean;
  link: CalendarLink | null;
  warnings: string[];
}

/** What earlier versions left behind: imported mails and files, a Gmail sign-in, a model API key. */
export interface LegacyData {
  messages: number;
  documents: number;
  credentials: ("gmail" | "llm_api_key")[];
}

export type TimerPhase = "focus" | "short_break" | "long_break";
export const TIMER_PHASES: TimerPhase[] = ["focus", "short_break", "long_break"];

/** A Pomodoro phase or a countdown; the server runs it (it ends on time while the window is in the tray). */
export interface TimerView {
  id: number;
  kind: "pomodoro" | "countdown";
  phase: TimerPhase | null;
  /** "until": a countdown to a moment (it cannot be paused). */
  mode: "duration" | "until";
  label: string;
  task_id: string | null;
  task_title: string | null;
  /** Which focus session of the set (Pomodoro). */
  cycle: number;
  status: "running" | "paused" | "finished" | "skipped" | "cancelled";
  duration_seconds: number;
  /** At the moment of `TimersOverview.now`. */
  remaining_seconds: number;
  ends_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface TimersOverview {
  /** The server's clock, to count down without drifting from it. */
  now: string;
  pomodoro: {
    current: TimerView | null;
    /** The phase that ended last (within the hour), while nothing runs. */
    last: TimerView | null;
    /** What a start begins, while nothing runs. */
    next: { phase: TimerPhase; cycle: number; duration_seconds: number } | null;
    long_break_every: number;
    today: { focus_sessions: number; focus_minutes: number };
  };
  /** Running and paused ones first (the nearest end first), then the finished ones. */
  countdowns: TimerView[];
}

export interface TimerAlarmState {
  alarm: {
    id: number;
    timer_id: number;
    phase: TimerPhase;
    title: string;
    body: string;
    finished_at: string;
    /** False for a phase that already ended while the app was off/asleep. */
    audible: boolean;
  } | null;
  sound_enabled: boolean;
}
