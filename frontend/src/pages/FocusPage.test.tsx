import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { Settings, SystemStatus, TimersOverview } from "@/lib/types";
import { makeTask, makeTimer, makeTimers } from "@/test/fixtures";
import FocusPage from "./FocusPage";

const TIMERS = {
  focus_minutes: 25,
  short_break_minutes: 5,
  long_break_minutes: 15,
  long_break_every: 4,
  auto_start_breaks: false,
  auto_start_focus: false,
  notify: true,
};

function renderFocus(entry = "/focus") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[entry]}>
          <FocusPage />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("FocusPage", () => {
  let timers: TimersOverview;

  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
    // jsdom lacks what Radix Select calls when it opens.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    timers = makeTimers();
    vi.spyOn(api, "timers").mockImplementation(async () => timers);
    vi.spyOn(api, "settings").mockResolvedValue({ general: { timezone: "Europe/Berlin" }, timers: TIMERS } as Settings);
    vi.spyOn(api, "systemStatus").mockResolvedValue({ desktop_notifications_supported: true } as SystemStatus);
    vi.spyOn(api, "tasks").mockResolvedValue({
      items: [makeTask({ id: "a", title: "Bericht schreiben" }), makeTask({ id: "b", title: "Formular", status: "in_progress" })],
      total: 2,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a focus session and then offers pause, skip and stop", async () => {
    const start = vi.spyOn(api, "startPomodoro").mockImplementation(async () => {
      timers = makeTimers({ pomodoro: { current: makeTimer(), next: null } });
      return timers;
    });
    renderFocus();
    expect(await screen.findByText("25:00")).toBeInTheDocument();
    expect(screen.getByText("专注 25 分钟，再休息 5 分钟；每 4 个番茄后长休息 15 分钟。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "开始专注" }));
    expect(start).toHaveBeenCalledWith({ phase: "focus", task_id: undefined });
    expect(await screen.findByText("专注中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳到休息" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    // The other phases cannot be picked while one runs.
    expect(screen.getByRole("tab", { name: "短休息" })).toBeDisabled();
  });

  it("counts down every second from what the server said", async () => {
    timers = makeTimers({ pomodoro: { current: makeTimer({ remaining_seconds: 600 }), next: null } });
    renderFocus();
    expect(await screen.findByText("10:00")).toBeInTheDocument();
    expect(await screen.findByText("09:59", undefined, { timeout: 2500 })).toBeInTheDocument();
  });

  it("lets the user pick a break instead, and link a focus session to a task", async () => {
    const start = vi.spyOn(api, "startPomodoro").mockResolvedValue(makeTimers());
    renderFocus();
    await userEvent.click(await screen.findByRole("tab", { name: "短休息" }));
    expect(screen.getByText("05:00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "开始短休息" }));
    expect(start).toHaveBeenLastCalledWith({ phase: "short_break", task_id: undefined });

    await userEvent.click(screen.getByRole("tab", { name: "专注" }));
    // Tasks being worked on come first.
    await userEvent.click(await screen.findByRole("combobox", { name: "专注于（可选）" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["不关联任务", "Formular", "Bericht schreiben"]);
    await userEvent.click(screen.getByRole("option", { name: "Bericht schreiben" }));
    await userEvent.click(screen.getByRole("button", { name: "开始专注" }));
    expect(start).toHaveBeenLastCalledWith({ phase: "focus", task_id: "a" });
  });

  it("reads the tasks again once a focus session on a task runs (the server moved it to 进行中)", async () => {
    vi.spyOn(api, "startPomodoro").mockImplementation(async () => {
      timers = makeTimers({ pomodoro: { current: makeTimer({ task_id: "a", task_title: "Bericht schreiben" }), next: null } });
      return timers;
    });
    renderFocus();
    await userEvent.click(await screen.findByRole("combobox", { name: "专注于（可选）" }));
    await userEvent.click(await screen.findByRole("option", { name: "Bericht schreiben" }));
    expect(api.tasks).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "开始专注" }));
    expect(await screen.findByRole("link", { name: "Bericht schreiben" })).toHaveAttribute("href", "/tasks/a");
    await waitFor(() => expect(api.tasks).toHaveBeenCalledTimes(2));
  });

  it("shows a paused session with its time left and a way on", async () => {
    timers = makeTimers({ pomodoro: { current: makeTimer({ status: "paused", remaining_seconds: 754, ends_at: null }), next: null } });
    const act = vi.spyOn(api, "timerAction").mockResolvedValue(makeTimers());
    renderFocus();
    expect(await screen.findByText("12:34")).toBeInTheDocument();
    expect(screen.getAllByText("已暂停").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(act).toHaveBeenCalledWith(1, "resume");
  });

  it("keeps the chosen phase and task when switching between compact and full views", async () => {
    const start = vi.spyOn(api, "startPomodoro").mockResolvedValue(makeTimers());
    renderFocus();
    await userEvent.click(await screen.findByRole("combobox", { name: "专注于（可选）" }));
    await userEvent.click(await screen.findByRole("option", { name: "Bericht schreiben" }));
    await userEvent.click(screen.getByRole("tab", { name: "长休息" }));
    const clock = screen.getByRole("timer");
    expect(clock).toHaveTextContent("15:00");

    await userEvent.click(screen.getByRole("button", { name: "简洁视图" }));
    expect(screen.getByRole("timer")).toBe(clock);
    expect(clock).toHaveTextContent("15:00");
    expect(screen.getByRole("link", { name: "返回任务" })).toHaveAttribute("href", "/");
    await userEvent.click(screen.getByRole("button", { name: "完整视图" }));
    expect(screen.getByRole("timer")).toBe(clock);
    expect(start).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("tab", { name: "专注" }));
    await userEvent.click(screen.getByRole("button", { name: "开始专注" }));
    expect(start).toHaveBeenCalledWith({ phase: "focus", task_id: "a" });
  });

  it("preserves a paused timer with hours across view changes and resumes it in compact view", async () => {
    timers = makeTimers({ pomodoro: { current: makeTimer({ status: "paused", remaining_seconds: 7199, ends_at: null }), next: null } });
    const act = vi.spyOn(api, "timerAction").mockImplementation(async () => {
      timers = makeTimers({ pomodoro: { current: makeTimer({ remaining_seconds: 7199 }), next: null } });
      return timers;
    });
    renderFocus("/focus?view=compact");
    const clock = await screen.findByRole("timer");
    expect(clock).toHaveTextContent("1:59:59");
    await userEvent.click(screen.getByRole("button", { name: "完整视图" }));
    await userEvent.click(screen.getByRole("button", { name: "简洁视图" }));
    expect(screen.getByRole("timer")).toBe(clock);
    expect(clock).toHaveTextContent("1:59:59");
    expect(act).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(act).toHaveBeenCalledWith(1, "resume");
    expect(await screen.findByRole("button", { name: "暂停" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "短休息" })).toBeDisabled();
  });

  it("after a focus session suggests the break, and counts the set and the day", async () => {
    timers = makeTimers({
      pomodoro: {
        last: makeTimer({ status: "finished", remaining_seconds: 0, ends_at: null, finished_at: "2026-10-14T08:25:00+00:00", cycle: 2 }),
        next: { phase: "short_break", cycle: 2, duration_seconds: 300 },
        today: { focus_sessions: 2, focus_minutes: 50 },
      },
    });
    renderFocus();
    expect(await screen.findByText("第 2 个番茄完成，休息一下吧。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始短休息" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "本轮完成 2/4 个番茄" })).toBeInTheDocument();
    expect(screen.getByText("2 个番茄")).toBeInTheDocument();
    expect(screen.getByText("共专注 50 分钟")).toBeInTheDocument();
  });

  it("says when Windows would show the notification only in its notification center", async () => {
    vi.spyOn(api, "systemStatus").mockResolvedValue({
      desktop_notifications_supported: true,
      start_menu: { supported: true, present: false, banners: false, ours: false },
    } as SystemStatus);
    renderFocus();
    expect(await screen.findByText(/计时结束的通知只会进入 Windows 通知中心/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去设置" })).toHaveAttribute("href", "/settings?section=reminders");
  });

  it("says when timer notifications are turned off", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({ general: { timezone: "Europe/Berlin" }, timers: { ...TIMERS, notify: false } } as Settings);
    renderFocus();
    await waitFor(() => expect(screen.getByText(/计时结束的 Windows 通知已在设置中关闭/)).toBeInTheDocument());
  });
});
