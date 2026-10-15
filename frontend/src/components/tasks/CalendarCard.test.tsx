import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api, ApiError } from "@/lib/api";
import type { CalendarLink, CalendarPreview, SystemStatus, TaskDetail } from "@/lib/types";
import { CalendarCard } from "./CalendarCard";

const ACTIVATION = "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456789012";

const task = {
  id: "t1",
  title: "Kalendertest",
  status: "confirmed",
  due_date: "2026-10-15",
  due_time: null,
  time_semantics: "deadline",
  timezone: "Europe/Berlin",
  due_version: 1,
  updated_at: null,
  calendar: null,
} as unknown as TaskDetail;

const preview: CalendarPreview = {
  event: {
    summary: "截止：Kalendertest",
    description: "Kalendertest",
    start: { date: "2026-10-15" },
    end: { date: "2026-10-16" },
    transparency: "transparent",
    reminders: { overrides: [{ method: "popup", minutes: 1440 }] },
  },
  event_kind: "all_day_deadline",
  calendar_name: "TaskRadar",
  connected: true,
  already_synced: false,
  link: null,
  warnings: [],
};

function disabledApi(details: Record<string, unknown>) {
  return new ApiError(502, "api_not_enabled", "The Google Calendar API is not enabled", false, details);
}

async function writeAndFail(details: Record<string, unknown>) {
  const status = { google: { calendar_connected: true }, ocr: { available: true, backlog: 0, reprocessing: false } };
  vi.spyOn(api, "systemStatus").mockResolvedValue(status as unknown as SystemStatus);
  vi.spyOn(api, "calendarPreview").mockResolvedValue(preview);
  vi.spyOn(api, "calendarSync").mockRejectedValue(disabledApi(details));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter>
          <CalendarCard task={task} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole("button", { name: /预览日历事件/ }));
  await userEvent.click(await screen.findByRole("button", { name: /确认写入/ }));
  return screen.findByRole("link", { name: /在 Google Cloud Console 中启用/ });
}

describe("CalendarCard", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("explains a disabled Google Calendar API and links to Google's switch", async () => {
    const link = await writeAndFail({ activation_url: ACTIVATION });
    expect(link).toHaveAttribute("href", ACTIVATION);
    expect(screen.getByText(/还没有启用 Google Calendar API/)).toBeInTheDocument();
  });

  it("removes the event only after an explicit confirmation", async () => {
    const link: CalendarLink = {
      calendar_id: "cal1@group.calendar.google.com",
      event_id: "tr1",
      event_kind: "all_day_deadline",
      status: "synced",
      html_link: "https://www.google.com/calendar/event?eid=x",
      last_error: null,
      attempts: 1,
      last_synced_at: "2026-10-15T09:26:46Z",
      synced_due_version: 1,
    };
    const status = { google: { calendar_connected: true }, ocr: { available: true, backlog: 0, reprocessing: false } };
    vi.spyOn(api, "systemStatus").mockResolvedValue(status as unknown as SystemStatus);
    const remove = vi.spyOn(api, "calendarRemove").mockResolvedValue({ ...link, status: "removed", html_link: null });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <MemoryRouter>
            <CalendarCard task={{ ...task, calendar: link } as TaskDetail} />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /从日历移除/ }));
    expect(remove).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/只会删除 TaskRadar 为这个任务创建的事件/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /从日历移除/ }));
    expect(remove).toHaveBeenCalledWith("t1");
  });

  it("never links anywhere but the Google Cloud Console", async () => {
    const link = await writeAndFail({ activation_url: "https://evil.example/enable" });
    expect(link).toHaveAttribute("href", "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com");
  });
});
