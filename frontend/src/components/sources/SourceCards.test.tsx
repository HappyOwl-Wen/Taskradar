import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api, ApiError } from "@/lib/api";
import type { Settings, SystemStatus } from "@/lib/types";
import { GmailRow } from "./SourceCards";

function renderRow() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter>
          <ul>
            <GmailRow sources={[]} timezone="Europe/Berlin" />
          </ul>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("GmailRow while the connection status is not known", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  beforeEach(() => {
    vi.spyOn(api, "settings").mockResolvedValue({ gmail: { lookback_days: 30 } } as Settings);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says it is checking instead of asking to connect again", async () => {
    vi.spyOn(api, "systemStatus").mockReturnValue(new Promise(() => undefined));
    renderRow();
    expect(await screen.findByText("正在检查连接…")).toBeInTheDocument();
    expect(screen.queryByText("未连接")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /前往连接/ })).not.toBeInTheDocument();
  });

  it("says it cannot tell when the status cannot be loaded, with a retry", async () => {
    vi.spyOn(api, "systemStatus").mockRejectedValue(new ApiError(500, "internal_error", "Internal server error"));
    renderRow();
    expect(await screen.findByText("暂时无法确认连接状态")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /前往连接/ })).not.toBeInTheDocument();
  });

  it("offers to connect only once it is known that Gmail is not connected", async () => {
    vi.spyOn(api, "systemStatus").mockResolvedValue({
      google: { gmail_connected: false, calendar_connected: false, client_configured: true },
      ocr: { reprocessing: false },
    } as SystemStatus);
    renderRow();
    expect(await screen.findByText("未连接")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /前往连接/ })).toHaveAttribute("href", "/settings?section=gmail");
  });
});
