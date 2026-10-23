import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api, type TaskQuery } from "@/lib/api";
import { addDays, todayIn } from "@/lib/format";
import type { Settings, TaskStatus, TaskSummary } from "@/lib/types";
import { makeDashboard, makeDetail, makeTask } from "@/test/fixtures";
import TasksPage from "./TasksPage";

// The server's state: the list asks for the statuses of its view.
let tasks: TaskSummary[] = [];

function renderTasks(client: QueryClient, path = "/tasks") {
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/tasks" element={<TasksPage />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const row = (title: string) => screen.getByText(title).closest(".group");

describe("TasksPage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  beforeEach(() => {
    tasks = [makeTask({ id: "rent", title: "Miete zahlen", status: "confirmed" }), makeTask({ id: "tax", title: "Steuer abgeben", status: "confirmed" })];
    vi.spyOn(api, "tasks").mockImplementation(async (query: TaskQuery = {}) => {
      const items = tasks.filter((t) => !query.status?.length || query.status.includes(t.status));
      return { items, total: items.length };
    });
    vi.spyOn(api, "dashboard").mockResolvedValue(makeDashboard({ counts: { ...makeDashboard().counts, active: 2, todo: 2 } }));
    vi.spyOn(api, "settings").mockResolvedValue({ general: { timezone: "Europe/Berlin" } } as Settings);
    vi.spyOn(api, "setStatus").mockImplementation(async (id: string, status: string) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, status: status as TaskStatus } : t));
      return { ...makeDetail(tasks.find((t) => t.id === id)), undo_event_id: 9 };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a task ticked off and brought back by undo is not left looking disabled", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderTasks(client);
    await userEvent.click(await screen.findByRole("checkbox", { name: "把「Miete zahlen」标记为已完成" }));
    // Done: it leaves the open view once the list has refreshed.
    await waitFor(() => expect(screen.queryByText("Miete zahlen")).not.toBeInTheDocument());

    // Undone (the server sets it back): it returns at full strength, ready to be ticked off again.
    tasks = tasks.map((t) => (t.id === "rent" ? { ...t, status: "confirmed" } : t));
    await act(() => client.invalidateQueries());
    await screen.findByText("Miete zahlen");
    expect(row("Miete zahlen")).not.toHaveClass("opacity-40");
    expect(screen.getByRole("checkbox", { name: "把「Miete zahlen」标记为已完成" })).toHaveAttribute("aria-checked", "false");
  });

  it("does not fade a task that stays in the list (all tasks), nor later in the open view", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderTasks(client, "/tasks?status=all");
    await userEvent.click(await screen.findByRole("checkbox", { name: "把「Miete zahlen」标记为已完成" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "把「Miete zahlen」恢复为未完成" })).toBeEnabled());
    await userEvent.click(screen.getByRole("checkbox", { name: "把「Miete zahlen」恢复为未完成" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "把「Miete zahlen」标记为已完成" })).toBeEnabled());
    expect(row("Miete zahlen")).not.toHaveClass("opacity-40");

    await userEvent.click(screen.getByRole("tab", { name: /未完成/ }));
    await screen.findByText("Miete zahlen");
    expect(row("Miete zahlen")).not.toHaveClass("opacity-40");
  });

  it("moves the selected tasks to another day at once and ends the selection", async () => {
    const move = vi.spyOn(api, "rescheduleTasks").mockImplementation(async (ids, dueDate) => ({
      changed: ids,
      count: ids.length,
      due_date: dueDate,
      undo_event_ids: [3, 4],
      skipped: [],
      calendar_outdated: [],
    }));
    renderTasks(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    await userEvent.click(await screen.findByRole("button", { name: "选择多项" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "选择「Miete zahlen」" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "选择「Steuer abgeben」" }));
    await userEvent.click(screen.getByRole("button", { name: "改期" }));
    await userEvent.click(await screen.findByRole("button", { name: /^明天/ }));

    await waitFor(() => expect(move).toHaveBeenCalledWith(["rent", "tax"], addDays(todayIn("Europe/Berlin"), 1)));
    expect(await screen.findByRole("button", { name: "选择多项" })).toBeInTheDocument(); // the selection has ended
  });

  it("offers no rescheduling for completed tasks, which keep their date", async () => {
    tasks = [makeTask({ id: "done", title: "Erledigt", status: "completed" })];
    renderTasks(new QueryClient({ defaultOptions: { queries: { retry: false } } }), "/tasks?status=completed");
    await userEvent.click(await screen.findByRole("button", { name: "选择多项" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "选择「Erledigt」" }));
    expect(screen.getByRole("button", { name: "恢复为待办" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "改期" })).not.toBeInTheDocument();
  });
});
