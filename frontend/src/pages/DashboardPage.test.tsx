import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { AttentionTask, Dashboard, SystemSummary } from "@/lib/types";
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

  it("names both tasks of a possible duplicate and that their deadlines differ", async () => {
    renderDashboard();
    expect(await screen.findByText("疑似同一件事 · 截止日期不同")).toBeInTheDocument();
    expect(screen.getByText("「Miete überweisen」")).toBeInTheDocument();
    expect(screen.getByText("「Mietzahlung Oktober」")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "对比审核" })).toBeInTheDocument();
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

  it("says when everything is running", async () => {
    renderDashboard();
    expect(await screen.findByText("一切正常")).toBeInTheDocument();
  });
});
