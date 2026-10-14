import { describe, expect, it } from "vitest";
import { diffPatch, initialState } from "./task-form";
import type { TaskDetail } from "./types";

const task = {
  id: "t1",
  title: "Pay semester fee",
  description: "",
  action_required: "Transfer 85 EUR",
  category: "financial",
  priority: "medium",
  due_date: "2026-11-20",
  due_time: null,
  time_semantics: "deadline",
} as unknown as TaskDetail;

describe("diffPatch", () => {
  it("sends nothing when nothing changed", () => {
    expect(diffPatch(task, initialState(task))).toEqual({});
  });

  it("sends only the edited fields", () => {
    const form = { ...initialState(task), title: "  Pay fee  ", priority: "high" as const };
    expect(diffPatch(task, form)).toEqual({ title: "Pay fee", priority: "high" });
  });

  it("clears the deadline explicitly", () => {
    const form = { ...initialState(task), due_date: "", due_time: "" };
    expect(diffPatch(task, form)).toEqual({ clear_due: true });
  });

  it("adds a time to a date-only deadline", () => {
    const form = { ...initialState(task), due_time: "14:00" };
    expect(diffPatch(task, form)).toEqual({ due_time: "14:00", due_date: "2026-11-20" });
  });

  it("keeps a date-only deadline date-only when the date moves", () => {
    const form = { ...initialState(task), due_date: "2026-11-27" };
    expect(diffPatch(task, form)).toEqual({ due_date: "2026-11-27" });
  });
});
