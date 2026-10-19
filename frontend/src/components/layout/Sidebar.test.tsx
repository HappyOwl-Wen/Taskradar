import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { makeDashboard, makeTimer, makeTimers } from "@/test/fixtures";
import { SidebarNav } from "./Sidebar";

function renderNav(path = "/", rail = false) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <SidebarNav rail={rail} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("SidebarNav", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has the timers in a group of their own, each with its page", async () => {
    vi.spyOn(api, "dashboard").mockResolvedValue(makeDashboard());
    vi.spyOn(api, "timers").mockResolvedValue(makeTimers());
    renderNav("/focus");
    const group = screen.getByRole("group", { name: "专注" });
    expect(group).toContainElement(screen.getByRole("link", { name: "番茄钟" }));
    expect(screen.getByRole("link", { name: "番茄钟" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "倒计时" })).toHaveAttribute("href", "/timers");
  });

  it("shows the time left of a running Pomodoro phase and of the countdown that ends first", async () => {
    vi.spyOn(api, "dashboard").mockResolvedValue(makeDashboard());
    vi.spyOn(api, "timers").mockResolvedValue(
      makeTimers({
        pomodoro: { current: makeTimer({ remaining_seconds: 1122 }), next: null },
        countdowns: [
          makeTimer({ id: 5, kind: "countdown", phase: null, remaining_seconds: 65 }),
          makeTimer({ id: 6, kind: "countdown", phase: null, remaining_seconds: 4000 }),
        ],
      }),
    );
    renderNav();
    expect(await screen.findByRole("link", { name: /^番茄钟\s*18:42$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^倒计时\s*01:05$/ })).toBeInTheDocument();
  });

  it("says when the Pomodoro timer is paused", async () => {
    vi.spyOn(api, "dashboard").mockResolvedValue(makeDashboard());
    vi.spyOn(api, "timers").mockResolvedValue(
      makeTimers({ pomodoro: { current: makeTimer({ status: "paused", remaining_seconds: 300, ends_at: null }), next: null } }),
    );
    renderNav("/", true);
    // In the narrow rail only a dot shows; the time is still there for screen readers.
    expect(await screen.findByRole("link", { name: /^番茄钟\s*已暂停 05:00$/ })).toBeInTheDocument();
  });
});
