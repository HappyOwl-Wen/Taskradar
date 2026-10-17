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
import type { GoogleStatus, Settings } from "@/lib/types";
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
      gmail: {
        auto_sync: false,
        lookback_days: 30,
        sync_interval_minutes: 30,
        query_extra: "",
        process_attachments: true,
        max_attachment_mb: 10,
        max_messages_per_sync: 200,
      },
    } as Settings;
    const status: GoogleStatus = {
      client: { configured: true, client_id_hint: "123456…apps.googleusercontent.com" },
      redirect_uri: "http://127.0.0.1:8000/api/oauth/google/callback",
      gmail: { connected: false, scopes: [], source: null },
      calendar: { connected: false, calendar_id: null, calendar_name: "TaskRadar", scopes: [] },
      last_authorization: null,
    };
    vi.spyOn(api, "settings").mockResolvedValue(settings);
    const google = vi.spyOn(api, "google").mockResolvedValue(status);
    vi.spyOn(api, "connectGoogle").mockResolvedValue({ auth_url: "https://accounts.google.com/o/oauth2/auth?state=s1" });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    setDesktopApp(true);

    renderSettings(["/settings?section=gmail"]);
    await userEvent.click(await screen.findByRole("button", { name: /连接 Gmail/ }));
    // Not inside the TaskRadar window: Google's page opens in the browser, the window waits for the answer.
    expect(open).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?state=s1", "_blank", "noopener,noreferrer");
    expect(await screen.findByText(/已在浏览器中打开 Google 授权页面/)).toBeInTheDocument();

    google.mockResolvedValue({
      ...status,
      gmail: { ...status.gmail, connected: true },
      last_authorization: { seq: 1, service: "gmail", ok: true, error: null },
    });
    await waitFor(() => expect(screen.queryByText(/已在浏览器中打开 Google 授权页面/)).not.toBeInTheDocument(), { timeout: 5000 });
  });
});
