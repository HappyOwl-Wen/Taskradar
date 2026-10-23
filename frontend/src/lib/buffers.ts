import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";
import { request } from "./api";
import type { CalendarDraft, CalendarItem, EventForm } from "./calendar";

/** Prep, commute or rest time reserved before and after an item. Stored on this computer, never sent to Google. */
export type BufferKind = "prep" | "commute" | "rest";
export const BUFFER_KINDS: BufferKind[] = ["prep", "commute", "rest"];
export const MAX_BUFFER_MINUTES = 240;
export interface Buffer { before_minutes: number; before_kind: BufferKind; after_minutes: number; after_kind: BufferKind }
/** As shown in the calendar: `series` when it comes from every occurrence of a recurring event. */
export interface ItemBuffer extends Buffer { series: boolean }
export const NO_BUFFER: Buffer = { before_minutes: 0, before_kind: "prep", after_minutes: 0, after_kind: "rest" };

export interface Conflict {
  id: string; kind: "work" | "google" | "appointment"; title: string; start: string; end: string;
  source_name: string; color: string;
  /** "overlap": the items themselves meet; "buffer": only reserved time does. */
  type: "overlap" | "buffer"; minutes: number;
  buffer: { owner: "other" | "self" | "both"; side: "before" | "after"; kind: BufferKind } | null;
}
export interface ConflictCheck { conflicts: Conflict[]; unchecked: string[]; suggestion: { start: string; end: string } | null }
export type BufferTarget = { work_block_id: string } | { calendar_id: string; event_id: string };

export const buffersApi = {
  conflicts: (form: EventForm, exclude: string[]) => request<ConflictCheck>("POST", "/api/calendar/conflicts", { body: {
    start: form.start, end: form.end, timezone: form.timezone, all_day: form.all_day,
    start_fold: form.start_fold ?? null, end_fold: form.end_fold ?? null, buffer: form.buffer ?? null, exclude,
  } }),
  save: (target: BufferTarget, buffer: Buffer, series = false) =>
    request<{ buffer: ItemBuffer | null }>("PUT", "/api/calendar/buffers", { body: { ...target, ...buffer, series } }),
};

export const hasBuffer = (buffer?: Buffer | null): buffer is Buffer => !!buffer && (buffer.before_minutes > 0 || buffer.after_minutes > 0);

/** "会前 15 分钟通勤 · 会后 10 分钟休息" / "15 min commute before · 10 min rest after". */
export function bufferSummary(t: TFunction, buffer?: Buffer | null): string {
  if (!hasBuffer(buffer)) return t("workbench.bufferNone");
  return [
    buffer.before_minutes ? t("workbench.bufferSideBefore", { minutes: buffer.before_minutes, kind: t(`workbench.kindInline_${buffer.before_kind}`) }) : "",
    buffer.after_minutes ? t("workbench.bufferSideAfter", { minutes: buffer.after_minutes, kind: t(`workbench.kindInline_${buffer.after_kind}`) }) : "",
  ].filter(Boolean).join(" · ");
}

/** Timed work blocks and Google events can carry buffers, read-only and recurring meetings included. */
export function bufferable(item: CalendarItem): boolean {
  return (item.kind === "work" || item.kind === "google") && !item.all_day;
}

export function bufferTarget(item: CalendarItem): BufferTarget {
  return item.kind === "work" ? { work_block_id: item.work_block_id! } : { calendar_id: item.calendar_id!, event_id: item.event_id! };
}

/** The buffer an editor starts with: the item's own, never one it only inherits from its series. */
export function formBuffer(item?: CalendarItem): Buffer | undefined {
  const buffer = item?.buffer;
  if (!buffer || buffer.series) return undefined;
  return { before_minutes: buffer.before_minutes, before_kind: buffer.before_kind, after_minutes: buffer.after_minutes, after_kind: buffer.after_kind };
}

/** Items the check leaves out: the one being edited, its Google copy, and a create retried under its reserved id. */
export function conflictExclude(item?: CalendarItem, draft?: Pick<CalendarDraft, "id" | "operation" | "calendar_id" | "event_id" | "work_block_id">): string[] {
  const ids = new Set<string>();
  if (item) ids.add(item.id);
  if (item?.calendar_id && item.event_id) ids.add(`google:${item.calendar_id}:${item.event_id}`);
  if (draft?.work_block_id) ids.add(`work:${draft.work_block_id}`);
  const eventId = draft?.event_id ?? (draft?.operation === "create" ? `trw${draft.id.replaceAll("-", "")}` : null);
  if (draft?.calendar_id && eventId) ids.add(`google:${draft.calendar_id}:${eventId}`);
  return [...ids];
}

/** The form moved to another start and end, written as local times of its own time zone. */
export function formAt(form: EventForm, start: string, end: string): EventForm {
  const local = (iso: string) => DateTime.fromISO(iso).setZone(form.timezone);
  const fold = (time: DateTime) => {
    const offsets = time.getPossibleOffsets();
    return offsets.length > 1 ? offsets.findIndex((d) => d.offset === time.offset) as 0 | 1 : null;
  };
  const a = local(start), b = local(end);
  return { ...form, start: a.toFormat("yyyy-MM-dd'T'HH:mm"), end: b.toFormat("yyyy-MM-dd'T'HH:mm"), start_fold: fold(a), end_fold: fold(b) };
}

export interface Band { side: "before" | "after"; kind: BufferKind; minutes: number }

/** Background bands for the week view: the reserved time drawn next to its item. */
export function bufferBands(items: CalendarItem[]) {
  return items.flatMap((item) => {
    const buffer = item.buffer;
    if (!hasBuffer(buffer) || item.all_day) return [];
    const start = DateTime.fromISO(item.start, { setZone: true }), end = DateTime.fromISO(item.end, { setZone: true });
    const bands: { side: "before" | "after"; from: DateTime; to: DateTime; kind: BufferKind; minutes: number }[] = [];
    if (buffer.before_minutes) bands.push({ side: "before", from: start.minus({ minutes: buffer.before_minutes }), to: start, kind: buffer.before_kind, minutes: buffer.before_minutes });
    if (buffer.after_minutes) bands.push({ side: "after", from: end, to: end.plus({ minutes: buffer.after_minutes }), kind: buffer.after_kind, minutes: buffer.after_minutes });
    return bands.map(({ side, from, to, kind, minutes }) => ({
      id: `${item.id}#${side}`, start: from.toISO()!, end: to.toISO()!, allDay: false, display: "background" as const,
      classNames: ["calendar-buffer", `calendar-buffer-${kind}`], extendedProps: { item, band: { side, kind, minutes } satisfies Band },
    }));
  });
}

/** Debounced overlap check of the times being typed; a stale answer stays visible but is marked as such. */
export function useConflicts(form: EventForm, exclude: string[], enabled: boolean) {
  const params = JSON.stringify({ start: form.start, end: form.end, timezone: form.timezone, all_day: form.all_day,
    start_fold: form.start_fold ?? null, end_fold: form.end_fold ?? null, buffer: form.buffer ?? null, exclude });
  // Validity travels with the debounced times: half-typed times are never sent.
  const [checked, setChecked] = useState({ params, enabled });
  useEffect(() => {
    const timer = setTimeout(() => setChecked({ params, enabled }), 300);
    return () => clearTimeout(timer);
  }, [params, enabled]);
  const query = useQuery({
    queryKey: ["calendar-conflicts", checked.params],
    queryFn: () => {
      const p = JSON.parse(checked.params) as EventForm & { exclude: string[] };
      return buffersApi.conflicts(p, p.exclude);
    },
    enabled: enabled && checked.enabled, placeholderData: keepPreviousData, retry: false, staleTime: 5_000,
  });
  return { data: enabled ? query.data : undefined, current: checked.params === params && !query.isPlaceholderData && !query.isFetching, failed: query.isError };
}
