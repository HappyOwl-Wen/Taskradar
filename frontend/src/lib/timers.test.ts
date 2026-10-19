import { describe, expect, it } from "vitest";
import { makeTimer } from "@/test/fixtures";
import { formatClock, isActive, isRunning, localMoment, progressOf } from "./timers";

describe("formatClock", () => {
  it("shows minutes and seconds, hours when needed, and days for long countdowns", () => {
    expect(formatClock(1500, "zh-CN")).toBe("25:00");
    expect(formatClock(59.4, "zh-CN")).toBe("00:59");
    expect(formatClock(3723, "zh-CN")).toBe("1:02:03");
    expect(formatClock(2 * 86_400 + 3 * 3600 + 4 * 60 + 5, "zh-CN")).toBe("2 天 03:04:05");
    expect(formatClock(2 * 86_400, "en")).toBe("2d 00:00:00");
    expect(formatClock(-3, "en")).toBe("00:00");
  });
});

describe("localMoment", () => {
  it("is the date and time in the user's time zone, rounded up to five minutes", () => {
    // 08:02 UTC is 10:02 in Berlin (summer time); one hour later, rounded up: 11:05.
    expect(localMoment("Europe/Berlin", 60, new Date("2026-10-14T08:02:00Z"))).toEqual({ date: "2026-10-14", time: "11:05" });
    // Across midnight in Shanghai.
    expect(localMoment("Asia/Shanghai", 60, new Date("2026-10-14T15:30:00Z"))).toEqual({ date: "2026-10-15", time: "00:30" });
  });
});

describe("timer states", () => {
  it("tells running, paused and ended timers apart", () => {
    expect(isRunning(makeTimer())).toBe(true);
    expect(isActive(makeTimer({ status: "paused" }))).toBe(true);
    expect(isRunning(makeTimer({ status: "paused" }))).toBe(false);
    expect(isActive(makeTimer({ status: "finished" }))).toBe(false);
    expect(isActive(null)).toBe(false);
  });

  it("measures how far a timer has run", () => {
    expect(progressOf(makeTimer({ duration_seconds: 600 }), 150)).toBe(0.75);
    expect(progressOf(makeTimer({ duration_seconds: 600 }), 900)).toBe(0);
    expect(progressOf(makeTimer({ duration_seconds: 0 }), 0)).toBe(0);
  });
});
