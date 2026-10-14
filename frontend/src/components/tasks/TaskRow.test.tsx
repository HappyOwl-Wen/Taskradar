import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import type { TaskSummary } from "@/lib/types";
import { TaskRow } from "./TaskRow";

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

function renderRow(props: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MemoryRouter>
          <TaskRow task={task} {...props} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("TaskRow", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("links to the task and shows its review flag and confidence", () => {
    renderRow();
    expect(screen.getByRole("link", { name: "提交在读证明" })).toHaveAttribute("href", "/tasks/t1");
    expect(screen.getByText("日期需确认")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(screen.getByLabelText("日期需要确认")).toBeInTheDocument();
  });

  it("shows a date-only deadline without inventing a time", () => {
    const { container } = renderRow();
    expect(container.textContent).toContain("11月20日");
    expect(container.textContent).not.toMatch(/23:59/);
  });

  it("offers a selection checkbox when selectable", () => {
    renderRow({ selected: false, onSelectedChange: () => undefined });
    expect(screen.getByRole("checkbox", { name: "提交在读证明" })).toBeInTheDocument();
  });
});
