import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/menu";
import { AppShell } from "./AppShell";

vi.mock("@/components/agent/AgentSidebar", () => ({ AgentSidebar: () => null }));

function mount() {
  const router = createMemoryRouter([{
    path: "/", element: <AppShell />, children: [
      { index: true, element: <h1>Workspace</h1> },
      { path: "tasks", element: <h1>Tasks destination</h1> },
    ],
  }]);
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  render(<QueryClientProvider client={client}><TooltipProvider><RouterProvider router={router} /></TooltipProvider></QueryClientProvider>);
  return { shell: document.querySelector<HTMLElement>(".app-shell")!, router };
}

describe("modal navigation on narrow and zoomed layouts", () => {
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  beforeAll(async () => {
    // jsdom has no scrolling implementation; keep the real route-change effect in this integration test.
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    await i18n.changeLanguage("zh-CN");
  });
  afterAll(() => {
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  });

  it("opens in a separate portal with its own material and makes the workspace inert", async () => {
    const { shell } = mount();
    await userEvent.click(screen.getByRole("button", { name: "展开导航" }));
    const dialog = await screen.findByRole("dialog", { name: "主导航" });
    expect(shell).not.toContainElement(dialog);
    expect(dialog).toHaveAttribute("data-surface", "navigation");
    expect(dialog).toHaveClass("nav-drawer");
    expect(dialog).not.toHaveClass("glass-dialog");
    expect(shell).toHaveAttribute("inert");
    expect(shell).toHaveAttribute("data-navigation-overlay", "open");
    expect(screen.queryByRole("heading", { name: "Workspace" })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("link", { name: "全部任务" })).toHaveLength(1);
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("keeps keyboard focus in the popup, then restores the opener and workspace on Escape", async () => {
    const user = userEvent.setup();
    const { shell } = mount();
    const opener = screen.getByRole("button", { name: "展开导航" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "主导航" });
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(shell).not.toHaveAttribute("inert");
    expect(shell).not.toHaveAttribute("data-navigation-overlay");
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes the popup and restores workspace interaction after navigation", async () => {
    const user = userEvent.setup();
    const { shell, router } = mount();
    await user.click(screen.getByRole("button", { name: "展开导航" }));
    const dialog = await screen.findByRole("dialog", { name: "主导航" });
    await user.click(within(dialog).getByRole("link", { name: "全部任务" }));
    await screen.findByRole("heading", { name: "Tasks destination" });
    expect(router.state.location.pathname).toBe("/tasks");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(shell).not.toHaveAttribute("inert");
    expect(shell).not.toHaveAttribute("data-navigation-overlay");
  });
});
