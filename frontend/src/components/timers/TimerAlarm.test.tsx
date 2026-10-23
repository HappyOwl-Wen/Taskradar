import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { BrowserAlarmSound } from "@/lib/alarmSound";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries";
import type { TimerAlarmState } from "@/lib/types";
import { TimerAlarm } from "./TimerAlarm";

function alarmState(overrides: Partial<TimerAlarmState> = {}): TimerAlarmState {
  return {
    alarm: { id: 10, timer_id: 1, phase: "focus", title: "专注结束", body: "第 1 个番茄完成。休息 5 分钟吧。", finished_at: "2026-10-22T12:00:00Z", audible: true },
    sound_enabled: true,
    ...overrides,
  };
}

function renderAlarm(desktop = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={client}>
      <input aria-label="未保存的任务" defaultValue="写到一半的待办" />
      <TimerAlarm desktop={desktop} />
    </QueryClientProvider>,
  );
  return { client, ...rendered };
}

describe("TimerAlarm", () => {
  beforeAll(async () => { await i18n.changeLanguage("zh-CN"); });

  beforeEach(() => {
    vi.spyOn(api, "timerAlarm").mockResolvedValue(alarmState());
    vi.spyOn(api, "dismissTimerAlarm").mockResolvedValue(alarmState({ alarm: null }));
    vi.spyOn(BrowserAlarmSound.prototype, "start").mockImplementation(() => {});
    vi.spyOn(BrowserAlarmSound.prototype, "stop").mockImplementation(() => {});
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps the completion dialog until Stop is acknowledged, then stops sound without losing the page draft", async () => {
    renderAlarm();
    const draft = screen.getByLabelText("未保存的任务");
    draft.focus();
    expect(await screen.findByRole("alertdialog", { name: "专注结束" })).toHaveTextContent("休息 5 分钟");
    await waitFor(() => expect(screen.getByRole("button", { name: "停止响铃" })).toHaveFocus());
    expect(BrowserAlarmSound.prototype.start).toHaveBeenCalledTimes(1);
    fireEvent.click(document.body);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(api.dismissTimerAlarm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "停止响铃" }));
    expect(api.dismissTimerAlarm).toHaveBeenCalledWith(10);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(BrowserAlarmSound.prototype.stop).toHaveBeenCalled();
    expect(screen.getByLabelText("未保存的任务")).toBe(draft);
    expect(draft).toHaveValue("写到一半的待办");
    await waitFor(() => expect(draft).toHaveFocus());
  });

  it("leaves desktop audio to the native process so sound is never doubled", async () => {
    renderAlarm(true);
    await screen.findByRole("alertdialog");
    expect(BrowserAlarmSound.prototype.start).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(api.dismissTimerAlarm).toHaveBeenCalledWith(10);
  });

  it("still shows a reminder when sound is off or the phase was missed", async () => {
    vi.mocked(api.timerAlarm).mockResolvedValue(alarmState({ sound_enabled: false }));
    renderAlarm();
    expect(await screen.findByRole("button", { name: "关闭提醒" })).toBeInTheDocument();
    expect(BrowserAlarmSound.prototype.start).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "关闭提醒" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("shows a stop failure and allows retrying without hiding or silencing the alarm prematurely", async () => {
    vi.mocked(api.dismissTimerAlarm).mockRejectedValueOnce(new Error("offline"));
    renderAlarm();
    await userEvent.click(await screen.findByRole("button", { name: "停止响铃" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "停止响铃" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(api.dismissTimerAlarm).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer phase's reminder when a previous dismissal finishes late", async () => {
    let respond: (state: TimerAlarmState) => void = () => {};
    vi.mocked(api.dismissTimerAlarm).mockImplementation(() => new Promise(resolve => { respond = resolve; }));
    const { client } = renderAlarm();
    await userEvent.click(await screen.findByRole("button", { name: "停止响铃" }));
    const following = alarmState({ alarm: { ...alarmState().alarm!, id: 11, phase: "short_break", title: "休息结束" } });
    vi.mocked(api.timerAlarm).mockResolvedValue(following);
    await act(async () => { client.setQueryData(qk.timerAlarm, following); respond(following); });
    expect(await screen.findByRole("alertdialog", { name: "休息结束" })).toBeInTheDocument();
    expect(api.dismissTimerAlarm).toHaveBeenCalledWith(10);
  });
});
