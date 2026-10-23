import { describe, expect, it } from "vitest";
import { addDays, daysBetween, formatDue, formatMinutes, formatSpan, nextWeekStart, relativeDue, todayIn } from "./format";

const base = { due_time: null, remaining_seconds: null, timezone: "Europe/Berlin" } as const;

describe("todayIn", () => {
  it("uses the calendar date of the given time zone", () => {
    // 23:30 UTC on 14 Oct is already 15 Oct in Berlin (UTC+2, summer time)
    expect(todayIn("Europe/Berlin", new Date("2026-10-14T23:30:00Z"))).toBe("2026-10-15");
    expect(todayIn("UTC", new Date("2026-10-14T23:30:00Z"))).toBe("2026-10-14");
  });

  it("handles the end of daylight saving time", () => {
    // DST ends 25 Oct 2026 at 03:00 local; 23:30 UTC that day is 00:30 on 26 Oct (UTC+1)
    expect(todayIn("Europe/Berlin", new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-26");
  });
});

describe("daysBetween", () => {
  it("counts whole calendar days, also across a DST change", () => {
    expect(daysBetween("2026-10-14", "2026-11-20")).toBe(37);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-10-14", "2026-10-10")).toBe(-4);
  });
});

describe("addDays", () => {
  it("moves by calendar days across months, years, leap days and a DST change", () => {
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("nextWeekStart", () => {
  it("is the Monday after the given day, whatever weekday that is", () => {
    // 19 Oct 2026 is a Monday.
    const week = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
    expect(week.map(nextWeekStart)).toEqual(Array(7).fill("2026-10-26"));
    expect(nextWeekStart("2026-12-30")).toBe("2027-01-04");
  });
});

describe("formatDue", () => {
  it("never invents a time for date-only deadlines", () => {
    const text = formatDue({ due_date: "2026-11-20", due_time: null }, "en", 2026);
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(text).toContain("20");
    expect(text).toContain("Nov");
  });

  it("shows the stated time for timed deadlines", () => {
    expect(formatDue({ due_date: "2026-11-20", due_time: "14:00" }, "zh-CN", 2026)).toMatch(/14:00$/);
  });

  it("shows the year only when it differs from the reference year", () => {
    expect(formatDue({ due_date: "2027-01-05", due_time: null }, "en", 2026)).toContain("2027");
    expect(formatDue({ due_date: "2026-01-05", due_time: null }, "en", 2026)).not.toContain("2026");
  });

  it("returns null without a deadline", () => {
    expect(formatDue({ due_date: null, due_time: null }, "en")).toBeNull();
  });
});

describe("relativeDue", () => {
  const now = new Date("2026-10-14T08:00:00Z");

  it("compares date-only deadlines by calendar day", () => {
    expect(relativeDue({ ...base, due_date: "2026-10-14" }, "en", now)).toEqual({ kind: "today" });
    expect(relativeDue({ ...base, due_date: "2026-10-17" }, "en", now)).toEqual({ kind: "remaining", value: "3 days" });
    expect(relativeDue({ ...base, due_date: "2026-10-12" }, "en", now)).toEqual({ kind: "overdue", value: "2 days" });
  });

  it("uses the remaining seconds for timed deadlines", () => {
    expect(relativeDue({ ...base, due_date: "2026-10-14", due_time: "18:00", remaining_seconds: 5 * 3600 }, "en", now)).toEqual({
      kind: "remaining",
      value: "5 hours",
    });
    expect(relativeDue({ ...base, due_date: "2026-10-13", due_time: "09:00", remaining_seconds: -26 * 3600 }, "en", now)).toEqual({
      kind: "overdue",
      value: "1 day",
    });
  });

  it("reports no deadline", () => {
    expect(relativeDue({ ...base, due_date: null }, "en", now)).toEqual({ kind: "none" });
  });
});

describe("durations", () => {
  it("formats spans and reminder offsets", () => {
    expect(formatSpan(90, "en")).toBe("2 minutes");
    expect(formatMinutes(1440, "en")).toBe("1 day");
    expect(formatMinutes(120, "en")).toBe("2 hours");
    expect(formatMinutes(45, "en")).toBe("45 minutes");
  });
});
