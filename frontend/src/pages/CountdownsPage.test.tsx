import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { Settings, SystemStatus, TimersOverview } from "@/lib/types";
import { makeTimer, makeTimers } from "@/test/fixtures";
import CountdownsPage from "./CountdownsPage";

function renderCountdowns() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter>
          <CountdownsPage />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const tea = makeTimer({
  id: 7,
  kind: "countdown",
  phase: null,
  label: "Tee",
  duration_seconds: 300,
  remaining_seconds: 185,
  ends_at: "2026-10-14T08:05:00+00:00",
});
const parking = makeTimer({
  id: 8,
  kind: "countdown",
  phase: null,
  mode: "until",
  label: "Parkuhr",
  duration_seconds: 9000,
  remaining_seconds: 9000,
  ends_at: "2026-10-14T10:30:00+00:00",
});
const pizza = makeTimer({
  id: 9,
  kind: "countdown",
  phase: null,
  label: "Pizza",
  status: "finished",
  duration_seconds: 720,
  remaining_seconds: 0,
  ends_at: null,
  finished_at: "2026-10-14T07:50:00+00:00",
});

describe("CountdownsPage", () => {
  let timers: TimersOverview;

  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  beforeEach(() => {
    timers = makeTimers();
    vi.spyOn(api, "timers").mockImplementation(async () => timers);
    vi.spyOn(api, "settings").mockResolvedValue({ general: { timezone: "Europe/Berlin" }, timers: { notify: true } } as Settings);
    vi.spyOn(api, "systemStatus").mockResolvedValue({ desktop_notifications_supported: true } as SystemStatus);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a countdown for a duration picked from the presets", async () => {
    const start = vi.spyOn(api, "startCountdown").mockImplementation(async () => {
      timers = makeTimers({ countdowns: [tea] });
      return timers;
    });
    renderCountdowns();
    expect(await screen.findByText("还没有倒计时")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "5分钟" }));
    await userEvent.type(screen.getByLabelText("名称（可选）"), "Tee");
    await userEvent.click(screen.getByRole("button", { name: "开始倒计时" }));
    expect(start).toHaveBeenCalledWith({ label: "Tee", seconds: 300 });
    expect(await screen.findByRole("timer", { name: "Tee：还剩 03:05" })).toBeInTheDocument();
    // The name field is empty again for the next one.
    expect(screen.getByLabelText("名称（可选）")).toHaveValue("");
  });

  it("adds hours, minutes and seconds up, and refuses more than 7 days", async () => {
    const start = vi.spyOn(api, "startCountdown").mockResolvedValue(makeTimers());
    renderCountdowns();
    const [hours, minutes, seconds] = await screen.findAllByRole("spinbutton");
    await userEvent.type(hours, "1");
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "2");
    await userEvent.type(seconds, "3");
    await userEvent.click(screen.getByRole("button", { name: "开始倒计时" }));
    expect(start).toHaveBeenCalledWith({ label: "", seconds: 3723 });

    await userEvent.clear(hours);
    await userEvent.type(hours, "169");
    expect(screen.getByRole("alert")).toHaveTextContent("倒计时最长 7 天。");
    expect(screen.getByRole("button", { name: "开始倒计时" })).toBeDisabled();
  });

  it("counts down to a moment in the user's time zone", async () => {
    const start = vi.spyOn(api, "startCountdown").mockResolvedValue(makeTimers());
    renderCountdowns();
    await userEvent.click(await screen.findByRole("tab", { name: "到某个时间" }));
    const date = screen.getByLabelText("日期");
    const time = screen.getByLabelText("时间");
    await userEvent.clear(date);
    await userEvent.type(date, "2026-10-20");
    await userEvent.clear(time);
    await userEvent.type(time, "18:30");
    await userEvent.click(screen.getByRole("button", { name: "开始倒计时" }));
    expect(start).toHaveBeenCalledWith({ label: "", until: "2026-10-20T18:30" });
  });

  it("lists running countdowns with their controls, then the finished ones", async () => {
    timers = makeTimers({ countdowns: [tea, parking, pizza] });
    // The answer is the timers' new state; here they stay as they are.
    const act = vi.spyOn(api, "timerAction").mockImplementation(async () => timers);
    const clear = vi.spyOn(api, "clearFinishedTimers").mockResolvedValue(makeTimers({ countdowns: [tea, parking] }));
    renderCountdowns();

    const running = await screen.findByRole("region", { name: /^进行中/ });
    expect(within(running).getByRole("timer", { name: "Tee：还剩 03:05" })).toBeInTheDocument();
    expect(within(running).getByRole("timer", { name: "Parkuhr：还剩 2:30:00" })).toBeInTheDocument();
    // Not today: with the date (in Berlin time).
    expect(within(running).getByText(/到 10\/14 12:30/)).toBeInTheDocument();
    // A countdown to a moment cannot be paused.
    expect(within(running).queryByRole("button", { name: "暂停「Parkuhr」" })).toBeNull();
    await userEvent.click(within(running).getByRole("button", { name: "暂停「Tee」" }));
    expect(act).toHaveBeenCalledWith(7, "pause");

    const finished = screen.getByRole("region", { name: "已结束（1）" });
    expect(within(finished).getByText(/已于 10\/14 09:50 结束/)).toBeInTheDocument();
    await userEvent.click(within(finished).getByRole("button", { name: "重新开始「Pizza」" }));
    expect(act).toHaveBeenCalledWith(9, "restart");
    await userEvent.click(screen.getByRole("button", { name: "清除已结束" }));
    expect(clear).toHaveBeenCalled();
  });
});
