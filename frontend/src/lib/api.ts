import type {
  AgentRun,
  CalendarLink,
  CalendarPreview,
  Dashboard,
  DocumentBrief,
  DocumentDetail,
  GoogleStatus,
  ImportResult,
  IngestOutcome,
  MessageDetail,
  MessageListItem,
  Metrics,
  NotificationItem,
  QuickParse,
  Settings,
  Source,
  RecheckResult,
  Suggestion,
  SyncJob,
  SystemStatus,
  SystemSummary,
  TaskDetail,
  TaskSummary,
} from "./types";

/** Error envelope returned by the backend: {"error": {code, message, recoverable, details}} */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly recoverable: boolean;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, recoverable = true, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.recoverable = recoverable;
    this.details = details;
  }
}

export interface SessionInfo {
  csrf_token: string;
  version: string;
  language: "zh-CN" | "en";
  theme: "system" | "light" | "dark";
  timezone: string;
  /** Shown in the TaskRadar desktop window rather than a browser tab (older servers leave it out). */
  desktop?: boolean;
}

let csrfToken: string | null = null;

export async function loadSession(): Promise<SessionInfo> {
  const response = await fetch("/api/session", { credentials: "same-origin" });
  if (!response.ok) throw new ApiError(response.status, "session_failed", "Could not reach the TaskRadar backend");
  const session = (await response.json()) as SessionInfo;
  csrfToken = session.csrf_token;
  return session;
}

type Query = Record<string, string | number | boolean | undefined | null | (string | number)[]>;

function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = await response.json();
    const err = body?.error;
    if (err?.code) return new ApiError(response.status, err.code, err.message ?? err.code, err.recoverable ?? true, err.details ?? {});
  } catch {
    /* fall through */
  }
  return new ApiError(response.status, "http_error", `HTTP ${response.status}`);
}

export async function request<T>(
  method: string,
  path: string,
  options: { query?: Query; body?: unknown; form?: FormData; retry?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const unsafe = method !== "GET" && method !== "HEAD";
  if (unsafe) {
    if (!csrfToken) await loadSession();
    headers["X-TaskRadar-CSRF"] = csrfToken ?? "";
  }
  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), { method, headers, body, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network_error", "The TaskRadar backend is not reachable");
  }
  if (!response.ok) {
    const error = await parseError(response);
    // The server restarted (new CSRF token): refresh once and retry.
    if (error.code === "csrf_failed" && options.retry !== false) {
      await loadSession();
      return request<T>(method, path, { ...options, retry: false });
    }
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const get = <T>(path: string, query?: Query) => request<T>("GET", path, { query });
const post = <T>(path: string, body?: unknown, query?: Query) => request<T>("POST", path, { body: body ?? {}, query });
const put = <T>(path: string, body?: unknown) => request<T>("PUT", path, { body: body ?? {} });
const patch = <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body: body ?? {} });
const del = <T>(path: string) => request<T>("DELETE", path);

export interface TaskQuery extends Query {
  status?: string[];
  category?: string[];
  urgency?: string[];
  source_kind?: string[];
  q?: string;
  needs_review?: boolean;
  /** true: only demo/test data, false: only real tasks, omitted: both. */
  sample?: boolean;
  /** Unconfirmed tasks and tasks with an open suggestion: everything waiting for a decision. */
  needs_decision?: boolean;
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
}

/** Which deadline survives a merge: the kept task's ("existing") or the merged-in task's ("new"). */
export type DueChoice = "existing" | "new";

export interface TaskPatch {
  title?: string;
  description?: string;
  action_required?: string;
  category?: string;
  priority?: string;
  due_date?: string | null;
  due_time?: string | null;
  time_semantics?: string;
  clear_due?: boolean;
}

export const api = {
  dashboard: () => get<Dashboard>("/api/dashboard"),
  tasks: (query: TaskQuery = {}) => get<{ items: TaskSummary[]; total: number }>("/api/tasks", query),
  task: (id: string) => get<TaskDetail>(`/api/tasks/${id}`),
  createTask: (body: Record<string, unknown>) => post<TaskDetail>("/api/tasks", body),
  quickParse: (text: string) => post<QuickParse>("/api/tasks/quick-parse", { text }),
  updateTask: (id: string, body: TaskPatch) => patch<TaskDetail>(`/api/tasks/${id}`, body),
  setStatus: (id: string, status: string, note?: string) => post<TaskDetail>(`/api/tasks/${id}/status`, { status, note }),
  batch: (ids: string[], action: string) =>
    post<{ changed: string[]; count: number; undo_event_ids?: number[] }>("/api/tasks/batch", { ids, action }),
  /** `dueChoice` is required when the two deadlines differ (the server answers 409 due_choice_required). */
  mergeTask: (id: string, intoTaskId: string, dueChoice?: DueChoice) =>
    post<TaskDetail>(`/api/tasks/${id}/merge`, { into_task_id: intoTaskId, due_choice: dueChoice ?? null }),
  deleteTask: (id: string) => del<{ deleted: string }>(`/api/tasks/${id}`),
  setSample: (id: string, sample: boolean) =>
    post<TaskDetail & { calendar_warning?: string }>(`/api/tasks/${id}/sample`, { sample }),
  /** Keep what an automatic change did (e.g. the new deadline) and clear the flag; undoable. */
  resolveReview: (id: string, reasons: string[]) => post<TaskDetail>(`/api/tasks/${id}/review/resolve`, { reasons }),
  recheck: () => get<RecheckResult>("/api/review/recheck"),
  undo: (eventId: number) => post<TaskDetail>(`/api/events/${eventId}/undo`),
  suggestions: () => get<{ items: Suggestion[] }>("/api/suggestions"),
  acceptSuggestion: (id: number, dueChoice?: DueChoice) =>
    post<TaskDetail>(`/api/suggestions/${id}/accept`, { due_choice: dueChoice ?? null }),
  rejectSuggestion: (id: number) => post<TaskDetail>(`/api/suggestions/${id}/reject`),
  calendarPreview: (id: string) => get<CalendarPreview>(`/api/tasks/${id}/calendar/preview`),
  calendarSync: (id: string) => post<CalendarLink & { unchanged?: boolean }>(`/api/tasks/${id}/calendar`, { confirm: true }),
  calendarRemove: (id: string) => post<CalendarLink>(`/api/tasks/${id}/calendar/remove`, { confirm: true }),

  sources: () => get<{ items: Source[] }>("/api/sources"),
  syncSource: (id: number) => post<{ job: SyncJob | null; accepted: boolean }>(`/api/sources/${id}/sync`),
  addFolder: (path: string, recursive: boolean) => post<Source>("/api/sources/folders", { path, recursive }),
  deleteSource: (id: number) => del<{ deleted: number; removed_tasks?: number }>(`/api/sources/${id}`),
  patchSource: (id: number, enabled: boolean) => patch<Source>(`/api/sources/${id}`, { enabled }),
  jobs: (limit = 30) => get<{ items: SyncJob[] }>("/api/sync-jobs", { limit }),
  failures: () => get<{ documents: DocumentBrief[]; messages: MessageListItem[]; jobs: SyncJob[] }>("/api/failures"),
  createDemoMailbox: () => post<Source>("/api/demo/mailbox"),
  advanceDemo: () => post<{ stage: number }>("/api/demo/advance"),
  setFailureMode: (mode: string) => put<{ mode: string }>("/api/demo/failure-mode", { mode }),

  documents: () => get<{ items: DocumentBrief[] }>("/api/documents", { limit: 1000 }),
  document: (id: number) => get<DocumentDetail>(`/api/documents/${id}`),
  upload: (files: File[]) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f, f.name));
    return request<{ results: ImportResult[] }>("POST", "/api/documents/upload", { form });
  },
  revealDocument: (id: number) => post<{ revealed: boolean }>(`/api/documents/${id}/reveal`),
  reprocessDocument: (id: number) => post<ImportResult>(`/api/documents/${id}/reprocess`),
  reprocessOcrBacklog: () => post<{ accepted: boolean; count: number; job: SyncJob | null }>("/api/documents/reprocess-ocr"),
  deleteDocument: (id: number) => del<{ deleted: number }>(`/api/documents/${id}`),
  documentFileUrl: (id: number) => `/api/documents/${id}/file`,
  messages: () => get<{ items: MessageListItem[] }>("/api/messages", { limit: 1000 }),
  message: (id: number) => get<MessageDetail>(`/api/messages/${id}`),
  deleteMessage: (id: number) => del<{ deleted: number }>(`/api/messages/${id}`),
  reprocessMessage: (id: number) => post<IngestOutcome>(`/api/messages/${id}/reprocess`),
  agentRuns: (limit = 50) => get<{ items: AgentRun[] }>("/api/agent-runs", { limit }),

  settings: () => get<Settings>("/api/settings"),
  updateSettings: (changes: Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>) => put<Settings>("/api/settings", changes),
  setApiKey: (apiKey: string) => put<{ configured: boolean }>("/api/settings/llm-key", { api_key: apiKey }),
  deleteApiKey: () => del<{ configured: boolean }>("/api/settings/llm-key"),
  testLlm: () => post<{ ok: boolean; model: string; latency_ms: number }>("/api/settings/llm/test"),
  systemStatus: () => get<SystemStatus>("/api/system/status"),
  systemSummary: () => get<SystemSummary>("/api/system/summary"),
  setAutostart: (enabled: boolean) => post<{ enabled: boolean }>("/api/system/autostart", { enabled, confirm: true }),
  google: () => get<GoogleStatus>("/api/integrations/google"),
  uploadClientConfig: (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<GoogleStatus["client"]>("POST", "/api/integrations/google/client-config", { form });
  },
  deleteClientConfig: () => del<GoogleStatus["client"]>("/api/integrations/google/client-config"),
  connectGoogle: (service: "gmail" | "calendar") => post<{ auth_url: string }>(`/api/integrations/google/${service}/connect`),
  updateDesktopState: (state: { unsaved?: boolean; theme?: "light" | "dark"; language?: "zh-CN" | "en" }) =>
    put<{ ok: boolean }>("/api/desktop/state", state),
  disconnectGoogle: (service: "gmail" | "calendar") => post<{ connected: boolean }>(`/api/integrations/google/${service}/disconnect`),

  notifications: () => get<{ items: NotificationItem[]; unread: number }>("/api/notifications", { limit: 30 }),
  markRead: (id?: number) => post<{ unread: number }>("/api/notifications/read", { id: id ?? null }),
  scanReminders: () => post<SyncJob>("/api/notifications/scan"),
  testDesktopNotification: () => post<{ delivered: boolean }>("/api/notifications/test-desktop"),
  metrics: () => get<Metrics>("/api/metrics"),
  exportUrl: (includeContent: boolean) => buildUrl("/api/data/export", { include_content: includeContent }),
  deleteAll: () => post<{ deleted: Record<string, number> }>("/api/data/delete-all", { confirm: "DELETE" }),
};
