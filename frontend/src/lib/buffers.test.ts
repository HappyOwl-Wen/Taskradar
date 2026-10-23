import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { bufferBands, bufferSummary, conflictExclude, formAt, formBuffer, hasBuffer, NO_BUFFER } from "./buffers";
import { eventForm, type CalendarItem } from "./calendar";

const work = { id: "work:b1", kind: "work", work_block_id: "b1", title: "Write", all_day: false, color: "#4f46e5",
  start: "2026-10-22T08:00:00+00:00", end: "2026-10-22T09:00:00+00:00" } as CalendarItem;

describe("buffers and overlap helpers", () => {
  it("leaves out the edited item, its Google copy and a create retried under its reserved id", () => {
    expect(conflictExclude(work)).toEqual(["work:b1"]);
    expect(conflictExclude({ ...work, calendar_id: "cal", event_id: "e1" })).toEqual(["work:b1", "google:cal:e1"]);
    const draft = { id: "0b5f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4", operation: "create" as const, calendar_id: "cal", event_id: null, work_block_id: "b1" };
    expect(conflictExclude(undefined, draft)).toEqual(["work:b1", "google:cal:trw0b5f1c2e3d4a4b5c8d6e7f8091a2b3c4"]);
    expect(conflictExclude()).toEqual([]);
  });
  it("moves a form to a suggested slot in its own zone and keeps the DST occurrence", () => {
    const form = eventForm(undefined, "Europe/Berlin", "2026-10-22T10:30");
    expect(formAt(form, "2026-10-22T09:00:00+00:00", "2026-10-22T10:00:00+00:00")).toMatchObject({ start: "2026-10-22T11:00", end: "2026-10-22T12:00", start_fold: null });
    // 01:30 UTC is the second 02:30 in Berlin on 25 October.
    expect(formAt(form, "2026-10-25T01:30:00+00:00", "2026-10-25T02:00:00+00:00")).toMatchObject({ start: "2026-10-25T02:30", start_fold: 1, end: "2026-10-25T03:00", end_fold: null });
  });
  it("draws reserved time next to its item and nothing for plain or all-day items", () => {
    const item = { ...work, buffer: { before_minutes: 30, before_kind: "commute", after_minutes: 10, after_kind: "rest", series: false } } as CalendarItem;
    const [before, after] = bufferBands([item, work, { ...item, id: "day", all_day: true }]).map((b) => ({ ...b, start: Date.parse(b.start), end: Date.parse(b.end) }));
    expect(before).toMatchObject({ id: "work:b1#before", display: "background", start: Date.parse("2026-10-22T07:30:00Z"), end: Date.parse("2026-10-22T08:00:00Z") });
    expect(before.extendedProps).toEqual({ item, band: { side: "before", kind: "commute", minutes: 30 } });
    expect(after).toMatchObject({ id: "work:b1#after", start: Date.parse("2026-10-22T09:00:00Z"), end: Date.parse("2026-10-22T09:10:00Z") });
    expect(bufferBands([item, work])).toHaveLength(2);
  });
  it("describes buffers in both languages and never starts an editor from a series buffer", async () => {
    const buffer = { before_minutes: 15, before_kind: "commute" as const, after_minutes: 10, after_kind: "rest" as const };
    await i18n.changeLanguage("en");
    expect(bufferSummary(i18n.t, buffer)).toBe("15 min commute before · 10 min rest after");
    expect(bufferSummary(i18n.t, NO_BUFFER)).toBe("None");
    await i18n.changeLanguage("zh-CN");
    expect(bufferSummary(i18n.t, { ...buffer, after_minutes: 0 })).toBe("会前 15 分钟通勤");
    expect(hasBuffer(NO_BUFFER)).toBe(false);
    expect(formBuffer({ ...work, buffer: { ...buffer, series: true } })).toBeUndefined();
    expect(formBuffer({ ...work, buffer: { ...buffer, series: false } })).toEqual(buffer);
  });
});
