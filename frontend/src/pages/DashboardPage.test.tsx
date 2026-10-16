import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { AttentionTask, Dashboard, SystemSummary, TaskSummary } from "@/lib/types";
import { makeSuggestion, makeTask } from "@/test/fixtures";
import DashboardPage from "./DashboardPage";

const day = (date: string) => ({ due_date: date, effective_deadline: `${date}T21:59:59+00:00` });

const overdue: AttentionTask = {
  ...makeTask({ id: "overdue", title: "Bücher zurückgeben", status: "confirmed", urgency: "overdue", ...day("2026-10-12") }),
  attention: "overdue",
  attention_flags: [],
};
const tomorrow: AttentionTask = {
  ...makeTask({ id: "tomorrow", title: "Formular abgeben", status: "candidate", urgency: "urgent", ...day("2026-10-16") }),
  attention: "due_tomorrow",
  attention_flags: ["unconfirmed"],
};
const disputed: AttentionTask = {
  ...makeTask({ id: "disputed", title: "Miete überweisen", status: "confirmed", urgency: "normal", ...day("2026-10-31") }),
  attention: "conflict",
  attention_flags: ["conflict"],
};

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    today: "2026-10-15",
    counts: {
      overdue: 1,
      today_focus: 1,
      upcoming_7d: 0,
      candidates: 1,
      needs_review: 0,
      active: 2,
      completed_7d: 0,
      pending_suggestions: 1,
      needs_action: 2,
      due_soon: 0,
      due_soon_candidates: 1,
      overdue_candidates: 0,
      conflicts: 2,
      sample_open: 4,
    },
    // The server sends them in this order; the page must not reorder by "conflict" first.
    attention: [overdue, tomorrow, disputed],
    attention_total: 3,
    attention_counts: { overdue: 1, due_tomorrow: 1, conflict: 1 },
    attention_unconfirmed: 1,
    today_focus: [],
    upcoming: [],
    overdue: [],
    candidates: [],
    suggestions: [
      makeSuggestion({
        task_id: "disputed",
        task_title: "Miete überweisen",
        task_status: "confirmed",
        task_due_date: "2026-10-31",
        related_task_id: "other",
        related_task_title: "Mietzahlung Oktober",
        related_due_date: "2026-11-03",
        deadlines_differ: true,
      }),
    ],
    recent_jobs: [],
    notifications_unread: 0,
    agent_mode: "rules",
    ...overrides,
  };
}

let summary: SystemSummary;
let queue: TaskSummary[];

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
    summary = { overall: "ok", checked_at: "2026-10-15T10:00:00+00:00", items: [] };
    vi.spyOn(api, "dashboard").mockResolvedValue(dashboard());
    vi.spyOn(api, "systemSummary").mockImplementation(async () => summary);
    // What waits for a decision: the unconfirmed task due tomorrow and the confirmed one with a duplicate suggestion.
    queue = [
      tomorrow,
      { ...disputed, pending_suggestions: 1, pending_suggestion_kinds: ["possible_duplicate"], review_reasons: ["possible_duplicate"], needs_review: true },
    ];
    vi.spyOn(api, "tasks").mockImplementation(async () => ({ items: queue, total: queue.length }));
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("groups what needs attention by how soon it is due, a disputed month-end date last", async () => {
    renderDashboard();
    await screen.findByText("Bücher zurückgeben");
    const groups = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(groups).toEqual(["已逾期", "明天截止", "截止日期有分歧"]);
    const tomorrowGroup = screen.getByRole("region", { name: "明天截止" });
    expect(within(tomorrowGroup).getByText("Formular abgeben")).toBeInTheDocument();
    // Unconfirmed tasks stay recognizable as such.
    expect(within(tomorrowGroup).getByText("待确认")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "截止日期有分歧" })).getByText("截止日期冲突")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "已逾期" })).queryByText("待确认")).not.toBeInTheDocument();
  });

  it("sums up the day in one sentence and keeps test data out of the numbers", async () => {
    renderDashboard();
    expect(await screen.findByText(/1 项已逾期，1 项明天截止（其中 1 项待确认）/)).toBeInTheDocument();
    expect(screen.getByText("另有 4 个测试或演示任务，未计入以上统计。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看" })).toHaveAttribute("href", "/tasks?view=all&sample=1");
  });

  it("has one entry for every decision: the count, each item with what is to be decided, and the way in", async () => {
    renderDashboard();
    expect(await screen.findByRole("heading", { name: "2 件事等待你决定" })).toBeInTheDocument();
    // The possible duplicate names the other task and its (different) deadline.
    expect(await screen.findByText(/与 「Mietzahlung Oktober」/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /开始确认/ })).toHaveAttribute("href", "/inbox");
    // No separate tiles or suggestion list repeating the same numbers.
    expect(screen.queryByText("需要我处理")).not.toBeInTheDocument();
    expect(screen.queryByText("待处理建议")).not.toBeInTheDocument();
  });

  it("names the other task of a suggestion from its details when the summary lacks it", async () => {
    vi.spyOn(api, "dashboard").mockResolvedValue(
      dashboard({ suggestions: [makeSuggestion({ task_id: "disputed", related_task_title: null, payload: { other_title: "Mietzahlung Oktober" } })] }),
    );
    renderDashboard();
    expect(await screen.findByText(/与 「Mietzahlung Oktober」/)).toBeInTheDocument();
    expect(screen.queryByText("「—」")).not.toBeInTheDocument();
  });

  it("guides a first-time user with one recommended way to start, until it is closed", async () => {
    vi.spyOn(api, "dashboard").mockResolvedValue(
      dashboard({ counts: { ...dashboard().counts, ever_confirmed: false, candidates: 0 } }),
    );
    renderDashboard();
    expect(await screen.findByRole("heading", { name: "开始使用 TaskRadar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入文件" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭使用入门" }));
    expect(screen.queryByRole("heading", { name: "开始使用 TaskRadar" })).not.toBeInTheDocument();
    // It can be opened again.
    fireEvent.click(screen.getByRole("button", { name: "使用入门" }));
    expect(screen.getByRole("heading", { name: "开始使用 TaskRadar" })).toBeInTheDocument();
  });

  it("explains runtime problems in plain words with a way to fix them", async () => {
    summary = {
      overall: "attention",
      checked_at: "2026-10-15T10:00:00+00:00",
      items: [{ code: "gmail_sync_failing", level: "warning", area: "gmail", params: { error: "rate_limited" }, since: null, action: "sources" }],
    };
    renderDashboard();
    expect(await screen.findByText("1 项需要注意")).toBeInTheDocument();
    expect(screen.getByText("Gmail 同步暂时失败")).toBeInTheDocument();
    expect(screen.getByText(/请求过于频繁，已安排稍后自动重试。/)).toBeInTheDocument();
    expect(screen.queryByText("rate_limited")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看来源" })).toHaveAttribute("href", "/sources");
  });

  it("does not say there is nothing to do while decisions are waiting", async () => {
    vi.spyOn(api, "dashboard").mockResolvedValue(dashboard({ attention: [disputed], attention_counts: { conflict: 1 }, attention_unconfirmed: 0 }));
    renderDashboard();
    expect(await screen.findByText("近期没有到期的任务，另有 2 件事等待你确认。")).toBeInTheDocument();
    expect(screen.queryByText("目前没有需要你关注的事项。")).not.toBeInTheDocument();
  });

  it("points to the queue for a disputed date that waits there, instead of listing it a second time", async () => {
    const queued: AttentionTask = { ...disputed, pending_suggestions: 1 };
    vi.spyOn(api, "dashboard").mockResolvedValue(dashboard({ attention: [overdue, queued], attention_counts: { overdue: 1, conflict: 1 } }));
    renderDashboard();
    const group = await screen.findByRole("region", { name: "截止日期有分歧" });
    expect(within(group).queryByText("Miete überweisen")).not.toBeInTheDocument();
    expect(within(group).getByRole("link", { name: /1 项在待确认中/ })).toHaveAttribute("href", "/inbox?task=disputed");
    // A disputed date that is not waiting for a decision stays listed.
    expect(within(screen.getByRole("region", { name: "已逾期" })).getByText("Bücher zurückgeben")).toBeInTheDocument();
  });

  it("says when everything is running", async () => {
    renderDashboard();
    // A quiet single line while nothing needs the user.
    expect(await screen.findByText("系统运行正常")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "系统状态" })).not.toBeInTheDocument();
  });
});
