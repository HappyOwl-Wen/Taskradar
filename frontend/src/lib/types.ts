// Mirrors the payloads produced by backend/src/taskradar/api/serializers.py

export type TaskStatus = "candidate" | "confirmed" | "in_progress" | "waiting_for_reply" | "completed" | "dismissed";
export type Category = "academic" | "administrative" | "financial" | "travel" | "personal" | "other";
export type Priority = "low" | "medium" | "high";
export type Urgency = "overdue" | "urgent" | "high" | "upcoming" | "normal" | "no_deadline" | "inactive";
export type DuePrecision = "none" | "date" | "datetime";
export type TimeSemantics = "deadline" | "appointment";

export const TASK_STATUSES: TaskStatus[] = [
  "candidate",
  "confirmed",
  "in_progress",
  "waiting_for_reply",
  "completed",
  "dismissed",
];
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
  source_kinds: string[];
  pending_suggestions: number;
  calendar_status: string | null;
  detected_at: string | null;
  source_published_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  manual: boolean;
}

export interface Evidence {
  quote: string;
  page: number | null;
  start: number | null;
  end: number | null;
  verified: boolean;
  kind: "action" | "deadline" | "completion" | "context";
}

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

export interface DocumentBrief {
  id: number;
  name: string;
  kind: "pdf" | "image";
  mime_type: string;
  size_bytes: number;
  page_count: number | null;
  extraction_method: string | null;
  ocr_engine: string | null;
  language: string | null;
  doc_date: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  warnings: string[];
  sha256: string;
  imported_at: string | null;
  processed_at: string | null;
  processing_ms: number | null;
  source_kind: string | null;
  original_path: string | null;
  has_stored_copy: boolean;
  message_id: number | null;
  text_chars: number;
  task_count?: number;
}

export interface TaskSourceEntry {
  id: number;
  relation: "origin" | "duplicate" | "deadline_update" | "completion_evidence" | "related" | "manual_merge";
  origin_key: string;
  label: string;
  source_date: string | null;
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

export interface Suggestion {
  id: number;
  task_id: string;
  kind: "mark_completed" | "mark_dismissed" | "update_due" | "possible_duplicate" | "mark_waiting";
  payload: Record<string, unknown>;
  evidence: Evidence[];
  confidence: number;
  reason: string;
  status: string;
  created_at: string | null;
  related_task_id: string | null;
  task_title?: string;
  task_status?: TaskStatus;
  related_task_title?: string | null;
}

export interface CalendarLink {
  calendar_id: string;
  event_id: string;
  event_kind: string;
  status: "synced" | "failed" | "out_of_sync" | string;
  html_link: string | null;
  last_error: string | null;
  attempts: number;
  last_synced_at: string | null;
  synced_due_version: number;
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
  suggestions: Suggestion[];
  calendar: CalendarLink | null;
  links: TaskLinkEntry[];
  split_task_id?: string | null;
}

export interface SyncJob {
  id: number;
  source_id: number | null;
  kind: string;
  trigger: string;
  status: "running" | "succeeded" | "partial" | "failed" | "interrupted";
  started_at: string | null;
  finished_at: string | null;
  items_seen: number;
  items_processed: number;
  items_skipped: number;
  items_failed: number;
  tasks_created: number;
  tasks_updated: number;
  error_code: string | null;
  error_message: string | null;
  recoverable: boolean;
  attempt: number;
  next_retry_at: string | null;
  details: Record<string, unknown>;
}

export interface Dashboard {
  today: string;
  counts: {
    overdue: number;
    today_focus: number;
    upcoming_7d: number;
    candidates: number;
    needs_review: number;
    active: number;
    completed_7d: number;
    pending_suggestions: number;
  };
  today_focus: TaskSummary[];
  upcoming: TaskSummary[];
  overdue: TaskSummary[];
  candidates: TaskSummary[];
  suggestions: Suggestion[];
  recent_jobs: SyncJob[];
  notifications_unread: number;
  agent_mode: "rules" | "llm";
}

export interface Source {
  id: number;
  kind: "gmail" | "demo_mail" | "upload" | "folder";
  name: string;
  account: string | null;
  folder_path: string | null;
  recursive: boolean;
  enabled: boolean;
  status: string;
  last_sync_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  documents?: number;
  messages?: number;
  last_job?: SyncJob | null;
  running?: boolean;
}

export interface MessageListItem extends MessageBrief {
  task_count: number;
  content_type: string | null;
  skip_reason: string | null;
  error_code: string | null;
}

export interface LinkedTask {
  id: string;
  title: string;
  status: TaskStatus;
  relation: TaskSourceEntry["relation"];
}

export interface DocumentDetail extends DocumentBrief {
  pages: { page: number; text: string; method: string; ocr_confidence: number | null }[];
  tasks: LinkedTask[];
  runs: AgentRun[];
}

export interface MessageDetail extends MessageBrief {
  recipients: string | null;
  labels: string[];
  body_text: string;
  skip_reason: string | null;
  error_code: string | null;
  attachments: DocumentBrief[];
  tasks: LinkedTask[];
  runs: AgentRun[];
}

export interface ImportResult {
  filename: string;
  status: string;
  created: boolean;
  document_id: number | null;
  message_id: number | null;
  error_code: string | null;
  error_message: string | null;
  tasks_created: number;
  duplicates_merged: number;
  suggestions_created: number;
  completions_applied: number;
  tasks_updated: number;
  content_type: string | null;
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

export interface AgentRun {
  id: number;
  message_id: number | null;
  document_id: number | null;
  extractor: string;
  provider: string | null;
  model: string | null;
  status: string;
  content_type: string | null;
  attempts: number;
  input_chars: number;
  redactions: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  candidates_count: number;
  error: string | null;
  trace: Record<string, unknown>[];
  created_at: string | null;
}

export interface Settings {
  general: { timezone: string; language: "zh-CN" | "en"; theme: "system" | "light" | "dark" };
  llm: {
    provider: "none" | "openai" | "openai_compatible";
    model: string;
    base_url: string | null;
    structured_mode: "json_schema" | "json_object";
    reasoning_effort: "minimal" | "low" | "medium" | "high" | null;
    cloud_consent: boolean;
    consent_at: string | null;
    redact_identifiers: boolean;
    prefilter: boolean;
    max_input_chars: number;
    timeout_seconds: number;
    max_retries: number;
    use_semantic_dedup: boolean;
    price_input_per_mtok: number | null;
    price_output_per_mtok: number | null;
  };
  gmail: {
    auto_sync: boolean;
    lookback_days: number;
    sync_interval_minutes: number;
    query_extra: string;
    process_attachments: boolean;
    max_attachment_mb: number;
    max_messages_per_sync: number;
  };
  folders: { scan_interval_minutes: number; max_file_mb: number };
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
  calendar: { calendar_name: string; auto_sync_enabled: boolean; auto_sync_categories: Category[]; reminder_minutes: number };
  policy: {
    review_confidence_threshold: number;
    auto_complete_on_explicit_confirmation: boolean;
    auto_complete_min_confidence: number;
    auto_apply_explicit_deadline_changes: boolean;
  };
  demo: { gmail_failure_mode: "none" | "rate_limit" | "server_error" | "auth" | "network" };
}

export interface SystemStatus {
  version: string;
  data_dir: string;
  ocr: { engine: string; available: boolean; languages: string[]; version: string | null };
  secret_store: { backend: string; available: boolean };
  scheduler: { running: boolean; jobs: { id: string; next_run_time: string | null }[] };
  agent_mode: "rules" | "llm";
  llm: { provider: string; model: string; api_key_configured: boolean; api_key_source: string | null; cloud_consent: boolean };
  google: { client_configured: boolean; gmail_connected: boolean; calendar_connected: boolean };
  autostart: { supported: boolean; enabled: boolean };
  desktop_notifications_supported: boolean;
  now: string;
}

export interface GoogleStatus {
  client: { configured: boolean; client_id_hint?: string };
  redirect_uri: string;
  gmail: { connected: boolean; scopes: string[]; source: Source | null };
  calendar: { connected: boolean; calendar_id: string | null; calendar_name: string; scopes: string[] };
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

export interface Metrics {
  documents: { total: number; by_status: Record<string, number>; success_rate: number | null; avg_processing_ms: number | null };
  messages: { total: number; by_status: Record<string, number>; success_rate: number | null };
  agent: {
    runs: number;
    avg_latency_ms: number | null;
    llm_runs: number;
    llm_fallbacks: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
    by_extractor: { extractor: string; runs: number; avg_latency_ms: number }[];
  };
  dedup: {
    duplicates_merged: number;
    merges_undone: number;
    wrong_merge_rate: number | null;
    possible_duplicate_suggestions: Record<string, number>;
    duplicate_rate: number | null;
  };
  feedback: {
    agent_tasks: number;
    by_status: Record<string, number>;
    accepted: number;
    dismissed: number;
    precision_proxy: number | null;
    automatic_status_changes: number;
    automatic_status_changes_undone: number;
  };
  agent_mode: "rules" | "llm";
}
