import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { markJustAdded } from "@/lib/justAdded";
import type { TaskSummary } from "@/lib/types";
import { TaskListItem } from "./TaskRow";

const task: TaskSummary = {
  id: "t1",
  title: "提交在读证明",
  category: "administrative",
  action_type: "submit",
  status: "candidate",
  priority: "medium",
  confidence: 0.72,
  due_at: "2026-11-20",
  due_date: "2026-11-20",
  due_time: null,
  due_precision: "date",
  due_text: "11月20日前",
  due_is_relative: false,
  due_needs_confirmation: true,
  time_semantics: "deadline",
  timezone: "Europe/Berlin",
  urgency: "normal",
  effective_deadline: "2026-11-20T22:59:59+00:00",
  remaining_seconds: 3_000_000,
  needs_review: true,
  review_reasons: ["date_needs_confirmation"],
  source_count: 2,
  source_kinds: ["upload"],
  pending_suggestions: 0,
  calendar_status: null,
  detected_at: null,
  source_published_at: null,
  source_published_day: null,
  created_at: null,
  updated_at: null,
  confirmed_at: null,
  completed_at: null,
  manual: false,
};

function renderRow(props: Partial<Parameters<typeof TaskListItem>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter>
          <TaskListItem task={task} {...props} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("TaskListItem", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("links to the task and names its problem in plain language, without a confidence percentage", () => {
    renderRow();
    expect(screen.getByRole("link", { name: "提交在读证明" })).toHaveAttribute("href", "/tasks/t1");
    expect(screen.getByText("日期需确认")).toBeInTheDocument();
    expect(screen.queryByText("72%")).not.toBeInTheDocument();
    expect(screen.queryByText(/置信度/)).not.toBeInTheDocument();
    // The date is rendered for narrow and wide lists (CSS shows one of them).
    expect(screen.getAllByLabelText("日期需要确认").length).toBeGreaterThan(0);
    // Category and sources live in the task itself, not in every row.
    expect(screen.queryByText("行政事务")).not.toBeInTheDocument();
  });

  it("shows a date-only deadline without inventing a time", () => {
    const { container } = renderRow();
    expect(container.textContent).toContain("11月20日");
    expect(container.textContent).not.toMatch(/23:59/);
  });

  it("offers a selection checkbox when selectable", () => {
    renderRow({ selected: false, onSelectedChange: () => undefined });
    expect(screen.getByRole("checkbox", { name: "选择「提交在读证明」" })).toBeInTheDocument();
  });

  it("shows an internal review code only as a human label", () => {
    renderRow({ task: { ...task, review_reasons: ["title_incomplete"], due_needs_confirmation: false } });
    expect(screen.getByText("内容待核实")).toBeInTheDocument();
    expect(screen.queryByText("title_incomplete")).not.toBeInTheDocument();
  });

  it("keeps a missing deadline quiet and does not flag reviewed tasks", () => {
    renderRow({
      task: {
        ...task,
        status: "confirmed",
        needs_review: false,
        due_date: null,
        due_at: null,
        effective_deadline: null,
        due_needs_confirmation: false,
        urgency: "no_deadline",
      },
    });
    expect(screen.getAllByText("无截止日期").length).toBeGreaterThan(0);
    expect(screen.queryByText("日期需确认")).not.toBeInTheDocument();
  });

  it("shows at most two key states; the rest opens with a click, not only on hover", async () => {
    renderRow({
      task: { ...task, sample: true, review_reasons: ["possible_duplicate", "title_incomplete"], due_needs_confirmation: false },
      showUnconfirmed: true,
    });
    // Unconfirmed and test data come first; the two problems are summed up.
    expect(screen.getByText("待确认")).toBeInTheDocument();
    expect(screen.getByText("测试数据")).toBeInTheDocument();
    expect(screen.queryByText("疑似重复")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "另有 2 项" }));
    expect(await screen.findByText("疑似重复")).toBeInTheDocument();
    expect(screen.getByText("内容待核实")).toBeInTheDocument();
  });

  it("names an open suggestion, so new tasks and changes can share one queue", () => {
    renderRow({ task: { ...task, status: "confirmed", needs_review: false, due_needs_confirmation: false, pending_suggestions: 1, pending_suggestion_kinds: ["update_due"] } });
    expect(screen.getByText("截止日期可能有变")).toBeInTheDocument();
  });

  it("names a possible duplicate once, even when it is both a doubt and a suggestion", () => {
    renderRow({
      task: { ...task, review_reasons: ["possible_duplicate"], due_needs_confirmation: false, pending_suggestions: 1, pending_suggestion_kinds: ["possible_duplicate"] },
    });
    expect(screen.getAllByText("疑似重复")).toHaveLength(1);
  });

  it("shows a calendar event that needs the user as a state", () => {
    renderRow({ task: { ...task, status: "confirmed", needs_review: false, due_needs_confirmation: false, calendar_status: "failed" } });
    expect(screen.getByText("日历写入失败")).toBeInTheDocument();
  });

  it("does not repeat a problem that the context already names", () => {
    renderRow({
      task: { ...task, status: "confirmed", review_reasons: ["possible_duplicate"], due_needs_confirmation: false },
      states: [{ key: "conflict", tone: "urgent", label: "截止日期冲突" }],
    });
    expect(screen.getByText("截止日期冲突")).toBeInTheDocument();
    expect(screen.queryByText("疑似重复")).not.toBeInTheDocument();
  });

  it("can select the task in place instead of navigating", () => {
    let opened = 0;
    renderRow({ onSelect: () => (opened += 1), active: true });
    const button = screen.getByRole("button", { name: "提交在读证明" });
    expect(button).toHaveAttribute("aria-current", "true");
    button.click();
    expect(opened).toBe(1);
  });

  it("marks a task the user has just added, for a moment", () => {
    vi.useFakeTimers();
    try {
      markJustAdded(task.id, 1000);
      const { container } = renderRow();
      const row = container.firstElementChild as HTMLElement;
      expect(row.className).toContain("animate-[just-added");
      act(() => vi.advanceTimersByTime(1000));
      expect(row.className).not.toContain("animate-[just-added");
    } finally {
      vi.useRealTimers();
    }
  });
});
