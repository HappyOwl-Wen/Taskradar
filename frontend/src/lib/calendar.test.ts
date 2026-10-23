import { describe, expect, it } from "vitest";
import { displayRange, eventDuration, eventForm, visibleItems, type CalendarItem, type CalendarView } from "./calendar";

describe("calendar time and source semantics", () => {
  it("renders all-day exclusive ends without an extra day", () => {
    const text = displayRange("2026-10-22", "2026-10-23", true, "Europe/Berlin", "en");
    expect(text).toContain("22"); expect(text).not.toContain("23"); expect(text).not.toContain("→");
  });
  it("shows elapsed duration and preserves the second DST occurrence on editing", () => {
    const item = { title: "Second occurrence", all_day: false, start: "2026-10-25T02:30:00+01:00", end: "2026-10-25T03:30:00+01:00" } as CalendarItem;
    const form = eventForm(item, "Europe/Berlin");
    expect(form.start).toBe("2026-10-25T02:30"); expect(form.start_fold).toBe(1);
    expect(eventDuration(form)).toBe(60);
    expect(eventDuration({ ...form, start_fold: 0 })).toBe(120);
  });
  it("keeps linked identities visible once when either of their sources is selected", () => {
    const data = { sources: [{ id: "own", selected: true }, { id: "other", selected: false }], items: [
      { id: "task", kind: "deadline", calendar_id: "own" }, { id: "local", kind: "work" }, { id: "hidden", kind: "google", calendar_id: "other" },
    ] } as CalendarView;
    expect(visibleItems(data, true).map((i) => i.id)).toEqual(["task", "local"]);
    expect(visibleItems(data, false).map((i) => i.id)).toEqual(["task"]);
  });
});
