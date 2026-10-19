import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { AttentionTask, Dashboard, TaskDetail } from "@/lib/types";
import { makeDashboard, makeDetail, makeTask } from "@/test/fixtures";
import DashboardPage from "./DashboardPage";

const day = (date: string) => ({ due_date: date, effective_deadline: `${date}T21:59:59+00:00` });

const late = makeTask({ id: "late", title: "Bücher zurückgeben", urgency: "overdue", ...day("2026-10-12") });
const working = makeTask({ id: "working", title: "Formular ausfüllen", status: "in_progress", urgency: "urgent", ...day("2026-10-15") });
const waiting = makeTask({ id: "waiting", title: "Antwort vom Vermieter", status: "waiting_for_reply", urgency: "no_deadline" });
const later = makeTask({ id: "later", title: "Steuererklärung", urgency: "normal", ...day("2026-11-30") });

function attention(task: typeof late, reason: AttentionTask["attention"]): AttentionTask {
  return { ...task, attention: reason };
}

function board(overrides: Partial<Dashboard> = {}): Dashboard {
  return makeDashboard({
    counts: {
      overdue: 1,
      due_today: 0,
      due_tomorrow: 1,
      due_soon: 0,
      active: 4,
      todo: 2,
      in_progress: 1,
      waiting_for_reply: 1,
      unconfirmed: 0,
      completed_7d: 0,
      sample_open: 2,
    },
    attention: [attention(late, "overdue"), attention(working, "due_tomorrow")],
    attention_total: 2,
    lanes: { todo: [late, later], in_progress: [working], waiting_for_reply: [waiting] },
    ...overrides,
  });
}

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("DashboardPage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  beforeEach(() => {
    vi.spyOn(api, "dashboard").mockResolvedValue(board());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sums up the day in one sentence and keeps test data out of the numbers", async () => {
    renderDashboard();
    expect(await screen.findByText("1 项已逾期，1 项明天截止；1 项进行中")).toBeInTheDocument();
    expect(screen.getByText("另有 2 个测试任务，未计入以上统计。")).toBeInTheDocument();
  });

  it("lists what is due by how soon, each task with its status", async () => {
    renderDashboard();
    const due = await screen.findByRole("region", { name: "已逾期" });
    expect(within(due).getByRole("link", { name: "Bücher zurückgeben" })).toBeInTheDocument();
    const tomorrow = screen.getByRole("region", { name: "明天截止" });
    // Switched to "in progress": that is visible right here, not only in the task.
    expect(within(tomorrow).getByText("进行中")).toBeInTheDocument();
  });

  it("shows a board with one lane per status, so a status change moves the task", async () => {
    renderDashboard();
    const todo = await screen.findByRole("region", { name: /^待办/ });
    expect(within(todo).getAllByRole("link").map((l) => l.textContent)).toEqual(["Bücher zurückgeben", "Steuererklärung"]);
    const progress = screen.getByRole("region", { name: /^进行中/ });
    expect(within(progress).getByRole("link", { name: "Formular ausfüllen" })).toBeInTheDocument();
    // The lane already says the status; the row does not repeat it.
    expect(within(progress).queryByText("进行中", { selector: "span" })).toBeNull();
    const reply = screen.getByRole("region", { name: /^等待回复/ });
    expect(within(reply).getByRole("link", { name: "Antwort vom Vermieter" })).toBeInTheDocument();
  });

  it("starts a to-do from its lane in one click", async () => {
    const started: TaskDetail = makeDetail({ ...later, status: "in_progress", undo_event_id: 9 });
    const setStatus = vi.spyOn(api, "setStatus").mockResolvedValue(started);
    renderDashboard();
    // Wide and narrow layouts each have the button (CSS shows one).
    await userEvent.click((await screen.findAllByRole("button", { name: "开始处理「Steuererklärung」" }))[0]);
    expect(setStatus).toHaveBeenCalledWith("later", "in_progress");
  });

  it("offers deleting a task right in its status menu", async () => {
    renderDashboard();
    const todo = await screen.findByRole("region", { name: /^待办/ });
    const rows = within(todo).getAllByRole("listitem");
    await userEvent.click(within(rows[1]).getAllByRole("button", { name: "状态：待办（点击修改）" })[0]);
    await userEvent.click(await screen.findByRole("menuitem", { name: "删除任务…" }));
    expect(await screen.findByRole("alertdialog", { name: "删除「Steuererklärung」？" })).toBeInTheDocument();
  });

  it("invites a first to-do on an empty start, with the guide one click away", async () => {
    vi.spyOn(api, "dashboard").mockResolvedValue(makeDashboard());
    renderDashboard();
    expect(await screen.findByText("还没有待办")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加待办" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看入门指南" })).toHaveAttribute("href", "/settings?section=guide");
    // The guide itself lives in the settings, not on the home page.
    expect(screen.queryByText("入门指南")).not.toBeInTheDocument();
  });
});
