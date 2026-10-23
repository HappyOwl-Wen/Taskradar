import { DateTime } from "luxon";
import { request } from "./api";

export interface RemoteEvent {
  id: string;
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  htmlLink?: string;
  status?: string;
  recurringEventId?: string;
  recurrence?: string[];
  attendees?: unknown[];
  eventType?: string;
}
export interface CalendarSource {
  id: string; summary: string; timezone: string; color: string; access_role: string;
  primary: boolean; selected: boolean; app_created: boolean; available: boolean; writable: boolean;
  last_synced_at: string | null; last_error: string | null; retry_at: string | null;
}
export interface CalendarSources {
  sources: CalendarSource[];
  capabilities: { connected: boolean; read: boolean; edit: boolean; app: boolean; scopes: string[] };
  default_calendar_id: string | null;
  google_edit_enabled: boolean;
}
export interface CalendarItem {
  id: string; kind: "deadline" | "work" | "google"; title: string; start: string; end: string;
  all_day: boolean; timezone: string; task_id?: string | null; task_status?: string | null;
  calendar_id?: string | null; event_id?: string | null; work_block_id?: string; revision?: number;
  source_name: string; editable: boolean; color: string; sync_status: string; needs_review?: boolean;
  remote?: RemoteEvent | null; html_link?: string | null; complex?: boolean; due_date?: string; due_time?: string | null;
}
export interface EventForm {
  title: string; description: string; location: string; all_day: boolean; start: string; end: string; timezone: string;
  start_fold?: 0 | 1 | null; end_fold?: 0 | 1 | null;
}
export interface CalendarDraft {
  id: string; operation: "create" | "update" | "delete"; calendar_id: string; event_id?: string | null;
  work_block_id?: string | null; payload: EventForm; base_event: RemoteEvent | Record<string, never>;
  remote_event?: RemoteEvent; status: string; last_error?: string | null;
}
export interface CalendarView extends CalendarSources {
  items: CalendarItem[]; unscheduled: { id: string; title: string }[]; drafts: CalendarDraft[];
  window_updated: Record<string, string | null>; timezone: string;
}
export const calendarApi = {
  view: (start: string, end: string) => request<CalendarView>("GET", "/api/calendar/view", { query: { start, end } }),
  sources: () => request<CalendarSources>("GET", "/api/calendar/sources"),
  refresh: (start: string, end: string) => request<{ status: string; error_code?: string }>("POST", "/api/calendar/refresh", { body: { start, end } }),
  select: (selected: string[], default_calendar_id: string | null, google_edit_enabled: boolean) => request<CalendarSources>("PUT", "/api/calendar/sources", { body: { selected, default_calendar_id, google_edit_enabled } }),
  saveBlock: (form: EventForm, task_id?: string | null, item?: CalendarItem) => request<CalendarItem>(item ? "PUT" : "POST", `/api/calendar/work-blocks${item ? `/${item.work_block_id}` : ""}`, { body: { ...form, task_id, revision: item?.revision } }),
  deleteBlock: (id: string) => request("DELETE", `/api/calendar/work-blocks/${id}`),
  detachBlock: (id: string) => request<CalendarItem>("POST", `/api/calendar/work-blocks/${id}/detach`),
  resolveTaskLink: (id: string, choice: "local" | "remote", etag: string) => request("POST", `/api/calendar/tasks/${id}/resolve-link`, { body: { choice, etag, confirm: true } }),
  taskBlocks: (id: string) => request<CalendarItem[]>("GET", `/api/calendar/tasks/${id}/work-blocks`),
  saveDraft: (draft: CalendarDraft) => request<CalendarDraft>("PUT", `/api/calendar/drafts/${draft.id}`, { body: draft }),
  commit: (id: string) => request<CalendarDraft>("POST", `/api/calendar/drafts/${id}/commit`, { body: { confirm: true } }),
  resolve: (id: string, choice: "rebase" | "discard") => request<CalendarDraft>("POST", `/api/calendar/drafts/${id}/resolve`, { body: { choice } }),
  linkTask: (calendar_id: string, event_id: string) => request<{ task_id: string }>("POST", "/api/calendar/link-task", { body: { calendar_id, event_id, confirm: true } }),
};

export function eventForm(item: CalendarItem | undefined, timezone: string, start?: string, title = ""): EventForm {
  const remote = item?.remote;
  const all_day = item?.all_day ?? false;
  const a = start ?? remote?.start?.dateTime ?? remote?.start?.date ?? item?.start;
  const from = a ? DateTime.fromISO(a, { zone: timezone }) : DateTime.now().setZone(timezone).plus({ hours: 1 }).startOf("hour");
  const b = remote?.end?.dateTime ?? remote?.end?.date ?? item?.end;
  const until = b ? DateTime.fromISO(b, { zone: timezone }) : from.plus({ hours: 1 });
  return { title: remote?.summary ?? item?.title ?? title, description: remote?.description ?? "", location: remote?.location ?? "",
    all_day, start: from.toFormat(all_day ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm"),
    end: until.toFormat(all_day ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm"), timezone,
    start_fold: from.getPossibleOffsets().length > 1 ? from.getPossibleOffsets().findIndex((d) => d.offset === from.offset) as 0 | 1 : null,
    end_fold: until.getPossibleOffsets().length > 1 ? until.getPossibleOffsets().findIndex((d) => d.offset === until.offset) as 0 | 1 : null };
}

export function eventDuration(form: EventForm): number {
  const moment = (key: "start" | "end") => {
    const time = DateTime.fromISO(form[key], { zone: form.timezone });
    return time.getPossibleOffsets()[form[`${key}_fold`] ?? 0] ?? time;
  };
  return moment("end").diff(moment("start"), "minutes").minutes;
}

export function visibleItems(data: CalendarView, local: boolean): CalendarItem[] {
  const selected = new Set(data.sources.filter((s) => s.selected).map((s) => s.id));
  return data.items.filter((item) => (local && item.kind !== "google") || (item.calendar_id && selected.has(item.calendar_id)));
}

export function displayRange(start: string, end: string, allDay: boolean, timezone: string, language: string): string {
  const a = DateTime.fromISO(start, { zone: timezone }).setLocale(language);
  let b = DateTime.fromISO(end, { zone: timezone }).setLocale(language);
  if (allDay) b = b.minus({ days: 1 }); // Google / FullCalendar all-day end is exclusive.
  const format = allDay ? "DDD" : "DDD HH:mm ZZZZ";
  return a.toFormat(format) + (allDay && a.hasSame(b, "day") ? "" : ` → ${b.toFormat(format)}`);
}
