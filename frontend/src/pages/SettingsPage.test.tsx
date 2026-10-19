import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { setDesktopApp } from "@/lib/desktop";
import type { GoogleStatus, Settings, SystemStatus } from "@/lib/types";
import SettingsPage from "./SettingsPage";

const SETTINGS = { general: { timezone: "Europe/Berlin", language: "zh-CN", theme: "system" } } as Settings;

function renderSettings(initialEntries = ["/settings?section=general"]) {
  // A sidebar link stands for every way out of the page (sidebar, search, links elsewhere).
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <>
            <Link to="/tasks">sidebar: tasks</Link>
            <Outlet />
          </>
        ),
        children: [
          { path: "settings", element: <SettingsPage /> },
          { path: "tasks", element: <p>tasks page</p> },
        ],
      },
    ],
    { initialEntries, initialIndex: initialEntries.length - 1 },
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe("SettingsPage: unsaved edits", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  beforeEach(() => {
    vi.spyOn(api, "settings").mockResolvedValue(SETTINGS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks before leaving through the sidebar, and keeps the draft when the user stays", async () => {
    const router = renderSettings();
    const timezone = await screen.findByLabelText("时区");
    await userEvent.clear(timezone);
    await userEvent.type(timezone, "Asia/Shanghai");
    expect(screen.getByText("有未保存的更改")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "sidebar: tasks" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("离开这一页后，刚才的修改不会保存。");
    await userEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(router.state.location.pathname).toBe("/settings");
    expect(screen.getByLabelText("时区")).toHaveValue("Asia/Shanghai");

    await userEvent.click(screen.getByRole("link", { name: "sidebar: tasks" }));
    await userEvent.click(await screen.findByRole("button", { name: "放弃更改" }));
    expect(await screen.findByText("tasks page")).toBeInTheDocument();
  });

  it("asks on the browser's back button too", async () => {
    const router = renderSettings(["/tasks", "/settings?section=general"]);
    const timezone = await screen.findByLabelText("时区");
    await userEvent.type(timezone, "x");
    await router.navigate(-1);
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(screen.queryByText("tasks page")).not.toBeInTheDocument();
  });

  it("leaves without asking when nothing was changed", async () => {
    renderSettings();
    await screen.findByLabelText("时区");
    await userEvent.click(screen.getByRole("link", { name: "sidebar: tasks" }));
    expect(await screen.findByText("tasks page")).toBeInTheDocument();
  });
});

describe("SettingsPage: signing in to Google from the desktop window", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    setDesktopApp(false);
    vi.restoreAllMocks();
  });

  it("opens Google in the system browser and shows the result when it comes back", async () => {
    const settings = {
      ...SETTINGS,
      calendar: { calendar_name: "TaskRadar", auto_sync_enabled: false, auto_sync_categories: [], reminder_minutes: 1440, remove_on_dismiss: true },
    } as Settings;
    const status: GoogleStatus = {
      client: { configured: true, client_id_hint: "123456…apps.googleusercontent.com" },
      redirect_uri: "http://127.0.0.1:8000/api/oauth/google/callback",
      calendar: { connected: false, calendar_id: null, calendar_name: "TaskRadar", scopes: ["https://www.googleapis.com/auth/calendar.app.created"] },
      last_authorization: null,
    };
    vi.spyOn(api, "settings").mockResolvedValue(settings);
    const google = vi.spyOn(api, "google").mockResolvedValue(status);
    const connect = vi.spyOn(api, "connectGoogle").mockResolvedValue({ auth_url: "https://accounts.google.com/o/oauth2/auth?state=s1" });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    setDesktopApp(true);

    renderSettings(["/settings?section=calendar"]);
    // The client file is there (step 1 done); step 2 connects.
    await userEvent.click(await screen.findByRole("button", { name: "连接 Google 日历" }));
    expect(connect).toHaveBeenCalledWith("calendar");
    // Not inside the TaskRadar window: Google's page opens in the browser, the window waits for the answer.
    expect(open).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?state=s1", "_blank", "noopener,noreferrer");
    expect(await screen.findByText(/已在浏览器中打开 Google 授权页面/)).toBeInTheDocument();

    google.mockResolvedValue({
      ...status,
      calendar: { ...status.calendar, connected: true },
      last_authorization: { seq: 1, service: "calendar", ok: true, error: null },
    });
    await waitFor(() => expect(screen.queryByText(/已在浏览器中打开 Google 授权页面/)).not.toBeInTheDocument(), { timeout: 5000 });
    expect(await screen.findByText("已连接，日历：TaskRadar")).toBeInTheDocument();
  });

  it("has no Gmail, extraction or automation sections any more", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(SETTINGS);
    renderSettings(["/settings?section=gmail"]);
    // An old link lands on the first section.
    expect(await screen.findByRole("heading", { name: "常规" })).toBeInTheDocument();
    for (const name of ["Gmail", "智能提取", "自动化"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "入门指南" }).length).toBeGreaterThan(0);
  });
});

describe("SettingsPage: Pomodoro and countdowns", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves the Pomodoro durations together", async () => {
    const timers = { focus_minutes: 25, short_break_minutes: 5, long_break_minutes: 15, long_break_every: 4, auto_start_breaks: false, auto_start_focus: false, notify: true };
    vi.spyOn(api, "settings").mockResolvedValue({ ...SETTINGS, timers });
    vi.spyOn(api, "systemStatus").mockResolvedValue({ desktop_notifications_supported: true } as SystemStatus);
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue({ ...SETTINGS, timers: { ...timers, focus_minutes: 50 } });
    renderSettings(["/settings?section=timers"]);
    const focus = await screen.findByLabelText("专注（分钟）");
    await userEvent.clear(focus);
    await userEvent.type(focus, "50");
    await userEvent.click(screen.getByRole("switch", { name: "专注结束后自动开始休息" }));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(update).toHaveBeenCalledWith({ timers: { focus_minutes: 50, auto_start_breaks: true } });
    expect(screen.getByRole("switch", { name: "计时结束时发出 Windows 通知" })).toBeChecked();
  });
});

describe("SettingsPage: notification banners", () => {
  const full = {
    general: { timezone: "Europe/Berlin", language: "zh-CN", theme: "system", close_to_tray: true },
    reminders: { urgent_hours: 24, high_days: 3, upcoming_days: 7, notify_candidates: false, notify_upcoming: true, overdue_repeat_hours: 24, scan_interval_minutes: 15 },
    notifications: { desktop_enabled: true, max_per_scan: 5 },
    calendar: { calendar_name: "TaskRadar", auto_sync_enabled: false, auto_sync_categories: [], reminder_minutes: 1440, remove_on_dismiss: true },
    timers: { focus_minutes: 25, short_break_minutes: 5, long_break_minutes: 15, long_break_every: 4, auto_start_breaks: false, auto_start_focus: false, notify: true },
  } as Settings;
  const status = (start_menu: SystemStatus["start_menu"]) =>
    ({ desktop_notifications_supported: true, start_menu, autostart: { supported: true, enabled: false } }) as SystemStatus;

  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("explains why Windows shows no banners and adds TaskRadar to the Start menu after asking", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(full);
    vi.spyOn(api, "systemStatus").mockResolvedValue(status({ supported: true, present: false, banners: false, ours: false }));
    const add = vi.spyOn(api, "setStartMenu").mockResolvedValue({ supported: true, present: true, banners: true, ours: true });
    renderSettings(["/settings?section=reminders"]);
    expect(await screen.findByText("Windows 不会弹出 TaskRadar 的通知。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "添加到开始菜单" }));
    const dialog = await screen.findByRole("alertdialog", { name: "在开始菜单中添加 TaskRadar？" });
    expect(dialog).toHaveTextContent("只为当前用户，不需要管理员权限");
    expect(add).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(add).toHaveBeenCalledWith(true);
  });

  it("says when banners work, and offers removing an entry made for this TaskRadar", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(full);
    vi.spyOn(api, "systemStatus").mockResolvedValue(status({ supported: true, present: true, banners: true, ours: true }));
    renderSettings(["/settings?section=reminders"]);
    expect(await screen.findByText(/Windows 会在屏幕右下角弹出 TaskRadar 的通知/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "从开始菜单移除" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加到开始菜单" })).not.toBeInTheDocument();
  });

  it("never offers removing the installed TaskRadar's entry", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(full);
    vi.spyOn(api, "systemStatus").mockResolvedValue(status({ supported: true, present: true, banners: true, ours: false }));
    renderSettings(["/settings?section=reminders"]);
    await screen.findByText(/Windows 会在屏幕右下角弹出 TaskRadar 的通知/);
    expect(screen.queryByRole("button", { name: "从开始菜单移除" })).not.toBeInTheDocument();
  });
});
