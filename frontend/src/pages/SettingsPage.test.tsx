import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { Settings } from "@/lib/types";
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
