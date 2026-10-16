import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { deadlinesDiffer, reasonParts, reviewReasonLabel, sortInbox, taskIssues } from "./review";
import type { TaskSummary } from "./types";

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: "t",
    title: "Task",
    category: "other",
    action_type: "other",
    status: "candidate",
    priority: "medium",
    confidence: 0.9,
    due_at: null,
    due_date: null,
    due_time: null,
    due_precision: "none",
    due_text: null,
    due_is_relative: false,
    due_needs_confirmation: false,
    time_semantics: "deadline",
    timezone: "Europe/Berlin",
    urgency: "no_deadline",
    effective_deadline: null,
    remaining_seconds: null,
    needs_review: false,
    review_reasons: [],
    source_count: 1,
    source_kinds: ["gmail"],
    pending_suggestions: 0,
    calendar_status: null,
    detected_at: "2026-10-10T08:00:00+00:00",
    source_published_at: null,
    source_published_day: null,
    created_at: null,
    updated_at: null,
    confirmed_at: null,
    completed_at: null,
    manual: false,
    ...overrides,
  };
}

const due = (date: string, urgency: TaskSummary["urgency"]) => ({ due_date: date, effective_deadline: `${date}T21:59:59+00:00`, urgency });

describe("taskIssues", () => {
  it("turns internal codes into a few plain issues, most serious first", () => {
    const issues = taskIssues(
      task({ needs_review: true, review_reasons: ["low_confidence", "title_incomplete", "ambiguous_date", "date_needs_confirmation", "possible_duplicate"] }),
    );
    expect(issues.map((i) => i.kind)).toEqual(["duplicate", "date_unclear", "content_unclear", "low_certainty"]);
    expect(issues.find((i) => i.kind === "date_unclear")?.reasons).toEqual(["ambiguous_date", "date_needs_confirmation"]);
  });

  it("drops the extractor's doubts once the user has reviewed the task, but not an unconfirmed date", () => {
    expect(taskIssues(task({ status: "confirmed", needs_review: false, review_reasons: ["low_confidence"] }))).toEqual([]);
    const issues = taskIssues(task({ status: "confirmed", needs_review: false, due_needs_confirmation: true }));
    expect(issues.map((i) => i.kind)).toEqual(["date_unclear"]);
  });

  it("names an automatic deadline change and a mere permission as their own issues", () => {
    const issues = taskIssues(task({ status: "confirmed", needs_review: true, review_reasons: ["permission_only", "deadline_changed"] }));
    expect(issues.map((i) => i.kind)).toEqual(["date_changed", "optional"]);
    expect(issues[0].severity).toBe("high");
    expect(issues[1].severity).toBe("low");
  });

  it("labels internal reasons in plain words and leaves unknown ones as they are", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(reviewReasonLabel("deadline_changed", i18n.t)).toBe("截止日期已更新");
    expect(reviewReasonLabel("permission_only", i18n.t)).toBe("可能只是可选");
    expect(reviewReasonLabel("something_new", i18n.t)).toBe("something_new");
  });

  it("ignores closed tasks and unknown codes", () => {
    expect(taskIssues(task({ status: "dismissed", needs_review: true, review_reasons: ["possible_duplicate"] }))).toEqual([]);
    expect(taskIssues(task({ needs_review: true, review_reasons: ["something_new"] }))).toEqual([]);
  });
});

describe("sortInbox", () => {
  const overdue = task({ id: "overdue", ...due("2026-10-01", "overdue") });
  const soon = task({ id: "soon", ...due("2026-10-16", "high") });
  const conflict = task({ id: "conflict", ...due("2026-12-01", "normal"), needs_review: true, review_reasons: ["date_conflict"] });
  const week = task({ id: "week", ...due("2026-10-20", "upcoming") });
  const unsure = task({ id: "unsure", ...due("2026-12-05", "normal"), needs_review: true, review_reasons: ["low_confidence"], confidence: 0.3 });
  const later = task({ id: "later", ...due("2026-11-30", "normal"), confidence: 0.99 });
  const undated = task({ id: "undated", detected_at: "2026-10-14T08:00:00+00:00" });

  it("orders by what needs handling first, not by the extractor's confidence", () => {
    const shuffled = [undated, later, unsure, week, conflict, soon, overdue];
    expect(sortInbox(shuffled, "priority").map((t) => t.id)).toEqual(["overdue", "soon", "conflict", "week", "unsure", "later", "undated"]);
  });

  it("can sort by deadline (undated last) or by newest detection", () => {
    expect(sortInbox([undated, later, soon], "due").map((t) => t.id)).toEqual(["soon", "later", "undated"]);
    expect(sortInbox([later, undated], "detected").map((t) => t.id)).toEqual(["undated", "later"]);
  });

  it("puts tasks with an open suggestion before ordinary ones", () => {
    const suggested = task({ id: "suggested", ...due("2026-12-10", "normal"), pending_suggestions: 1 });
    expect(sortInbox([later, suggested], "priority").map((t) => t.id)).toEqual(["suggested", "later"]);
  });
});

describe("helpers", () => {
  it("detects differing deadlines the way the server does", () => {
    expect(deadlinesDiffer({ due_date: "2026-11-03", due_time: "12:00" }, { due_date: "2026-11-03", due_time: null })).toBe(true);
    expect(deadlinesDiffer({ due_date: "2026-11-03", due_time: null }, { due_date: null, due_time: null })).toBe(true);
    expect(deadlinesDiffer({ due_date: null, due_time: null }, { due_date: "2026-11-03", due_time: null })).toBe(false);
    expect(deadlinesDiffer({ due_date: "2026-11-03", due_time: null }, { due_date: "2026-11-03", due_time: null })).toBe(false);
  });

  it("splits rule signals for the technical details", () => {
    expect(reasonParts("entities=None; action=0.80;  text=0.41;")).toEqual(["entities=None", "action=0.80", "text=0.41"]);
    expect(reasonParts(null)).toEqual([]);
  });
});
