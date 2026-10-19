import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { markJustAdded } from "@/lib/justAdded";
import { makeTask } from "@/test/fixtures";
import { TaskListItem } from "./TaskRow";

const task = makeTask({
  title: "交房租",
  category: "financial",
  due_at: "2026-11-20",
  due_date: "2026-11-20",
  due_precision: "date",
  urgency: "normal",
  effective_deadline: "2026-11-20T22:59:59+00:00",
  remaining_seconds: 3_000_000,
});

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

  it("links to the task and keeps the row to title and date", () => {
    renderRow();
    expect(screen.getByRole("link", { name: "交房租" })).toHaveAttribute("href", "/tasks/t1");
    // A to-do is the normal case: no status badge, no category, no confidence.
    expect(screen.queryByText("待办")).not.toBeInTheDocument();
    expect(screen.queryByText("财务")).not.toBeInTheDocument();
    expect(screen.queryByText(/100%|置信度/)).not.toBeInTheDocument();
  });

  it("shows a date-only deadline without inventing a time", () => {
    const { container } = renderRow();
    expect(container.textContent).toContain("11月20日");
    expect(container.textContent).not.toMatch(/23:59/);
  });

  it("shows when a task is being worked on or waits for a reply, wherever it is listed", () => {
    const { rerender } = renderRow({ task: { ...task, status: "in_progress" } });
    expect(screen.getByText("进行中")).toBeInTheDocument();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <MemoryRouter>
            <TaskListItem task={{ ...task, status: "waiting_for_reply" }} />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText("等待回复")).toBeInTheDocument();
    expect(screen.queryByText("进行中")).not.toBeInTheDocument();
  });

  it("leaves the status out where the context already says it (a lane of the board)", () => {
    renderRow({ task: { ...task, status: "in_progress" }, hideStatus: true });
    expect(screen.queryByText("进行中")).not.toBeInTheDocument();
  });

  it("marks tasks of earlier versions that were never confirmed", () => {
    renderRow({ task: { ...task, status: "candidate", manual: false } });
    expect(screen.getByText("待确认")).toBeInTheDocument();
  });

  it("offers a selection checkbox when selectable", () => {
    renderRow({ selected: false, onSelectedChange: () => undefined });
    expect(screen.getByRole("checkbox", { name: "选择「交房租」" })).toBeInTheDocument();
  });

  it("keeps a missing deadline quiet", () => {
    renderRow({ task: { ...task, due_date: null, due_at: null, effective_deadline: null, urgency: "no_deadline" } });
    expect(screen.getAllByText("无截止日期").length).toBeGreaterThan(0);
  });

  it("shows at most two key states; the rest opens with a click, not only on hover", async () => {
    renderRow({ task: { ...task, status: "in_progress", sample: true, calendar_status: "failed" } });
    expect(screen.getByText("进行中")).toBeInTheDocument();
    expect(screen.getByText("测试数据")).toBeInTheDocument();
    expect(screen.queryByText("日历写入失败")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "另有 1 项" }));
    expect(await screen.findByText("日历写入失败")).toBeInTheDocument();
  });

  it("shows a calendar event that needs the user as a state", () => {
    renderRow({ task: { ...task, calendar_status: "failed" } });
    expect(screen.getByText("日历写入失败")).toBeInTheDocument();
  });

  it("can select the task in place instead of navigating", () => {
    let opened = 0;
    renderRow({ onSelect: () => (opened += 1), active: true });
    const button = screen.getByRole("button", { name: "交房租" });
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
