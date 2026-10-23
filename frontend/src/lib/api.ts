import type {
  CalendarLink,
  CalendarPreview,
  Dashboard,
  GoogleStatus,
  LegacyData,
  NotificationItem,
  QuickParse,
  Settings,
  SystemStatus,
  SystemSummary,
  TaskDetail,
  TaskSummary,
  TimerPhase,
  TimersOverview,
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
  q?: string;
  /** true: only test data, false: only real tasks, omitted: both. */
  sample?: boolean;
  /** true: only the user's own to-dos; false: only tasks found in mails and files by earlier versions. */
  manual?: boolean;
  /** true: only tasks with an event in TaskRadar's Google calendar. */
  in_calendar?: boolean;
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
}

/** What can be done to a running (or finished) timer. */
export type TimerAction = "pause" | "resume" | "skip" | "restart" | "cancel";

/** What a selection of tasks can be set to at once ("todo" reopens; "delete" removes them for good). */
export type BatchAction = "todo" | "in_progress" | "waiting_for_reply" | "complete" | "dismiss" | "delete";

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
  quickParse: (text: string) => post<QuickParse>("/api/tasks/quick-parse", { text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  updateTask: (id: string, body: TaskPatch) => patch<TaskDetail>(`/api/tasks/${id}`, body),
  setStatus: (id: string, status: string, note?: string) => post<TaskDetail>(`/api/tasks/${id}/status`, { status, note }),
  batch: (ids: string[], action: BatchAction) =>
    post<{ changed?: string[]; deleted?: string[]; count: number; undo_event_ids?: number[]; calendar_not_removed?: string[] }>(
      "/api/tasks/batch",
      { ids, action },
    ),
  deleteTask: (id: string) => del<{ deleted: string; calendar_warning?: string }>(`/api/tasks/${id}`),
  setSample: (id: string, sample: boolean) => post<TaskDetail>(`/api/tasks/${id}/sample`, { sample }),
  undo: (eventId: number) => post<TaskDetail>(`/api/events/${eventId}/undo`),
  calendarPreview: (id: string) => get<CalendarPreview>(`/api/tasks/${id}/calendar/preview`),
  calendarSync: (id: string) => post<CalendarLink & { unchanged?: boolean }>(`/api/tasks/${id}/calendar`, { confirm: true }),
  calendarRemove: (id: string) => post<CalendarLink>(`/api/tasks/${id}/calendar/remove`, { confirm: true }),

  settings: () => get<Settings>("/api/settings"),
  updateSettings: (changes: Partial<{ [K in keyof Settings]: Partial<Settings[K]> }>) => put<Settings>("/api/settings", changes),
  systemStatus: () => get<SystemStatus>("/api/system/status"),
  systemSummary: () => get<SystemSummary>("/api/system/summary"),
  setAutostart: (enabled: boolean) => post<{ enabled: boolean }>("/api/system/autostart", { enabled, confirm: true }),
  setStartMenu: (enabled: boolean) =>
    post<NonNullable<SystemStatus["start_menu"]>>("/api/system/start-menu", { enabled, confirm: true }),
  google: () => get<GoogleStatus>("/api/integrations/google"),
  uploadClientConfig: (file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<GoogleStatus["client"]>("POST", "/api/integrations/google/client-config", { form });
  },
  deleteClientConfig: () => del<GoogleStatus["client"]>("/api/integrations/google/client-config"),
  connectGoogle: (service: "calendar", access: "app" | "read" | "edit" = "app") => post<{ auth_url: string }>(`/api/integrations/google/${service}/connect`, { access }),
  disconnectGoogle: (service: "calendar") => post<{ connected: boolean }>(`/api/integrations/google/${service}/disconnect`),
  updateDesktopState: (state: { unsaved?: boolean; theme?: "light" | "dark"; language?: "zh-CN" | "en" }) =>
    put<{ ok: boolean }>("/api/desktop/state", state),

  timers: () => get<TimersOverview>("/api/timers"),
  startPomodoro: (body: { phase?: TimerPhase; task_id?: string } = {}) => post<TimersOverview>("/api/timers/pomodoro", body),
  /** A duration in seconds, or an end time "YYYY-MM-DDTHH:MM" in the user's time zone. */
  startCountdown: (body: { label?: string; seconds?: number; until?: string }) => post<TimersOverview>("/api/timers/countdowns", body),
  timerAction: (id: number, action: TimerAction) => post<TimersOverview>(`/api/timers/${id}/${action}`),
  clearFinishedTimers: () => post<TimersOverview>("/api/timers/clear-finished"),

  notifications: () => get<{ items: NotificationItem[]; unread: number }>("/api/notifications", { limit: 30 }),
  markRead: (id?: number) => post<{ unread: number }>("/api/notifications/read", { id: id ?? null }),
  scanReminders: () => post<{ details?: Record<string, unknown> }>("/api/notifications/scan"),
  testDesktopNotification: () => post<{ delivered: boolean }>("/api/notifications/test-desktop"),
  exportUrl: (includeContent: boolean) => buildUrl("/api/data/export", { include_content: includeContent }),
  deleteAll: () => post<{ deleted: Record<string, number> }>("/api/data/delete-all", { confirm: "DELETE" }),
  legacyData: () => get<LegacyData>("/api/data/legacy"),
  deleteImported: () => post<{ deleted: Record<string, number> }>("/api/data/delete-imported", { confirm: true }),
  deleteLegacyCredential: (name: LegacyData["credentials"][number]) =>
    del<{ credentials: LegacyData["credentials"] }>(`/api/data/legacy-credentials/${name}`),
};
