import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { calendarApi, type CalendarItem, type CalendarView } from "@/lib/calendar";
import { qk } from "@/lib/queries";
import type { GoogleStatus, Settings } from "@/lib/types";
import CalendarPage from "./CalendarPage";
import { SidebarWeek } from "@/components/layout/SidebarWeek";

const items: CalendarItem[] = ["2026-10-01", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-30", "2026-11-05"].map((date) => ({
  id: date, kind: "deadline", title: `Plan ${date}`, start: date, end: `${date}T23:59:59`,
  all_day: true, timezone: "Europe/Berlin", source_name: "local", editable: false, color: "#4f46e5", sync_status: "local",
}));

function workspace(start = "2026-10-01", end = "2026-11-01"): CalendarView {
  return {
    items: items.filter((item) => item.start >= start && item.start < end), sources: [], unscheduled: [], drafts: [],
    capabilities: { connected: false, read: false, edit: false, app: false, scopes: [] },
    default_calendar_id: null, google_edit_enabled: false, window_updated: {}, timezone: "Europe/Berlin",
  };
}

function mount(path = "/calendar", timezone = "Europe/Berlin", connected = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const settings = { general: { timezone } } as Settings;
  const google = { calendar: { connected } } as GoogleStatus;
  vi.mocked(api.settings).mockResolvedValue(settings);
  vi.mocked(api.google).mockResolvedValue(google);
  client.setQueryData(qk.settings, settings);
  client.setQueryData(qk.google, google);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>
    <SidebarWeek />
    <Link to="/calendar">Open calendar</Link><Link to="/other">Leave calendar</Link><Link to="/calendar?date=2026-10-30">Date shortcut</Link>
    <Routes><Route path="/calendar" element={<CalendarPage />} /><Route path="/other" element={<p>Other page</p>} /></Routes>
  </MemoryRouter></QueryClientProvider>);
  return client;
}

const scroller = () => document.querySelector<HTMLElement>(".fc-list .fc-scroller")!;
const nextFrame = () => act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
  vi.stubGlobal("innerWidth", 1024);
  vi.spyOn(api, "settings");
  vi.spyOn(api, "google");
  vi.spyOn(calendarApi, "view").mockImplementation(async (start, end) => workspace(start, end));
  vi.spyOn(calendarApi, "refresh").mockResolvedValue({ status: "succeeded" });

  // jsdom has no layout. Give the real FullCalendar rows 100px each within its list scroller.
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches(".fc-list .fc-scroller")) return new DOMRect(0, 200, 800, 500);
    if (this.matches(".fc-list-day[data-date]")) {
      const container = this.closest<HTMLElement>(".fc-scroller")!;
      const index = Array.from(container.querySelectorAll(".fc-list-day")).indexOf(this);
      return new DOMRect(0, 200 + index * 100 - container.scrollTop, 800, 100);
    }
    return originalRect.call(this);
  });
});

describe("calendar view preference and automatic refresh", () => {
  it.each([["Month", "dayGridMonth"], ["Week", "timeGridWeek"], ["Day", "timeGridDay"], ["Agenda", "listMonth"]])("restores the last %s view when reopened", async (label, view) => {
    localStorage.setItem("taskradar.calendar.view", view === "dayGridMonth" ? "listMonth" : "dayGridMonth");
    mount();
    await userEvent.click(screen.getByRole("button", { name: label }));
    await userEvent.click(screen.getByRole("link", { name: "Leave calendar" }));
    vi.stubGlobal("innerWidth", 480);
    await userEvent.click(screen.getByRole("link", { name: "Open calendar" }));
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores an obsolete view preference", async () => {
    localStorage.setItem("taskradar.calendar.view", "listYear");
    mount();
    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    await screen.findByText("Plan 2026-10-23");
  });

  it("refreshes Google on every calendar navigation, including clicking the current entry", async () => {
    mount("/calendar", "Europe/Berlin", true);
    await waitFor(() => expect(calendarApi.refresh).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("link", { name: "Open calendar" }));
    await waitFor(() => expect(calendarApi.refresh).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("link", { name: "Leave calendar" }));
    await userEvent.click(screen.getByRole("link", { name: "Open calendar" }));
    await waitFor(() => expect(calendarApi.refresh).toHaveBeenCalledTimes(3));
    expect(calendarApi.refresh).toHaveBeenLastCalledWith("2026-09-28", "2026-11-02");
  });

  it("reloads local plans on reopening even while the previous query is fresh", async () => {
    mount();
    await screen.findByText("Plan 2026-10-23");
    await userEvent.click(screen.getByRole("link", { name: "Leave calendar" }));
    vi.mocked(calendarApi.view).mockImplementation(async (start, end) => {
      const data = workspace(start, end);
      return { ...data, items: data.items.map((item) => ({ ...item, title: `${item.title} updated` })) };
    });
    await userEvent.click(screen.getByRole("link", { name: "Open calendar" }));
    await screen.findByText("Plan 2026-10-23 updated");
    expect(calendarApi.refresh).not.toHaveBeenCalled();
  });

  it("keeps network failures quiet and clears their status after a successful retry", async () => {
    const errorToast = vi.spyOn(toast, "error");
    vi.mocked(calendarApi.refresh).mockRejectedValueOnce(new Error("Offline"));
    mount("/calendar", "Europe/Berlin", true);
    await screen.findByText("Refresh failed");
    expect(screen.getByRole("button", { name: "Sync details" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(i18n.t("workbench.refreshFailed"))).not.toBeInTheDocument();
    expect(errorToast).not.toHaveBeenCalled();
    expect(screen.getByText("Plan 2026-10-23")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sync details"));
    expect(screen.queryByText("Refresh failed")).not.toBeInTheDocument();
  });

  it.each(["failed", "partial"])("keeps a %s refresh result in details instead of a banner", async (status) => {
    vi.mocked(calendarApi.refresh).mockResolvedValueOnce({ status });
    mount("/calendar", "Europe/Berlin", true);
    await screen.findByText("Refresh failed");
    const message = i18n.t(status === "partial" ? "workbench.partial" : "workbench.refreshFailed");
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sync details" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("calendar agenda navigation", () => {
  it("opens a linked day despite a different saved calendar view", async () => {
    localStorage.setItem("taskradar.calendar.view", "dayGridMonth");
    mount("/calendar?date=2026-10-23&view=timeGridDay");
    expect(screen.getByRole("button", { name: /^Day$/ })).toHaveAttribute("aria-pressed", "true");
    await screen.findByText("Plan 2026-10-23");
    expect(calendarApi.view).toHaveBeenLastCalledWith("2026-10-23", "2026-10-24");
    expect(screen.queryByText("Plan 2026-10-24")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".fc-col-header-cell")).toHaveLength(1);
  });

  it("shows the clicked day's plans and follows another sidebar date without leaving the calendar", async () => {
    mount();
    await screen.findByText("Plan 2026-10-23");
    await userEvent.click(screen.getByRole("link", { name: "Friday, October 23, 2026" }));
    await waitFor(() => expect(calendarApi.view).toHaveBeenLastCalledWith("2026-10-23", "2026-10-24"));
    expect(screen.getByRole("button", { name: /^Day$/ })).toHaveAttribute("aria-pressed", "true");
    await screen.findByText("Plan 2026-10-23");
    await userEvent.click(screen.getByRole("link", { name: "Saturday, October 24, 2026" }));
    await screen.findByText("Plan 2026-10-24");
    expect(calendarApi.view).toHaveBeenLastCalledWith("2026-10-24", "2026-10-25");
    expect(screen.queryByText("Plan 2026-10-23")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Saturday, October 24, 2026" })).toHaveAttribute("aria-current", "date");
  });

  it("keeps the sidebar and date field in sync with daily previous/next navigation and shows empty days", async () => {
    mount("/calendar?date=2026-10-23&view=timeGridDay");
    await screen.findByText("Plan 2026-10-23");
    await userEvent.click(screen.getByRole("button", { name: "Next period" }));
    await screen.findByText("Plan 2026-10-24");
    expect(screen.getByLabelText("Go to date")).toHaveValue("2026-10-24");
    expect(screen.getByRole("link", { name: "Saturday, October 24, 2026" })).toHaveAttribute("aria-current", "date");
    await userEvent.click(screen.getByRole("button", { name: "Next period" }));
    await screen.findByText(i18n.t("workbench.empty"));
    expect(calendarApi.view).toHaveBeenLastCalledWith("2026-10-25", "2026-10-26");
    expect(screen.queryByText("Plan 2026-10-24")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Previous period" }));
    await screen.findByText("Plan 2026-10-24");
    expect(screen.getByLabelText("Go to date")).toHaveValue("2026-10-24");
  });

  it("follows a sidebar date shortcut while the calendar is already open", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(200));
    await userEvent.click(screen.getByRole("link", { name: "Date shortcut" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(400));
  });

  it("opens at today, keeps earlier plans available, and focuses today again on re-entry", async () => {
    mount();
    await screen.findByText("Plan 2026-10-23");
    await userEvent.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(200));
    expect(document.querySelector('.fc-list-day[data-date="2026-10-01"]')).toBeInTheDocument();
    expect(document.querySelector('.fc-list-day[data-date="2026-10-23"] .calendar-today-badge')).toHaveTextContent("Today");
    expect(document.querySelector('.fc-list-day[data-date="2026-10-23"] [aria-current="date"]')).toBeInTheDocument();
    expect(document.querySelectorAll(".calendar-today-badge")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Month" }));
    await userEvent.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(200));
  });

  it("focuses today after the initial mobile agenda finishes loading", async () => {
    vi.stubGlobal("innerWidth", 480);
    let resolve!: (value: CalendarView) => void;
    vi.mocked(calendarApi.view).mockImplementation(() => new Promise((done) => { resolve = done; }));
    mount();
    await waitFor(() => expect(calendarApi.view).toHaveBeenCalled());
    expect(document.querySelector(".fc-list-day")).toBeNull();

    await act(async () => resolve(workspace()));
    await waitFor(() => expect(scroller().scrollTop).toBe(200));
  });

  it("uses the next scheduled day when today has no plans", async () => {
    vi.mocked(calendarApi.view).mockImplementation(async (start, end) => ({
      ...workspace(start, end), items: workspace(start, end).items.filter((item) => item.start !== "2026-10-23"),
    }));
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(document.querySelector('.fc-list-day[data-date="2026-10-24"]')).toBeInTheDocument());
    await waitFor(() => expect(scroller().scrollTop).toBe(200));
    expect(document.querySelector(".calendar-today-badge")).toBeNull();
  });

  it("uses today in the configured display timezone", async () => {
    vi.setSystemTime(new Date("2026-10-23T00:30:00Z"));
    mount("/calendar", "America/Los_Angeles");
    await userEvent.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(100));
    expect(document.querySelector(".fc-list-day.fc-day-today")).toHaveAttribute("data-date", "2026-10-22");
    expect(document.querySelector('.fc-list-day[data-date="2026-10-22"] .calendar-today-badge')).toHaveTextContent("Today");
    expect(document.querySelector('.fc-list-day[data-date="2026-10-23"] .calendar-today-badge')).toBeNull();
  });

  it("keeps the user's scroll position when calendar data refreshes", async () => {
    const client = mount();
    await userEvent.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(200));
    scroller().scrollTop = 50;
    const updated = workspace();
    updated.items = updated.items.map((item) => ({ ...item, title: `${item.title} updated` }));
    act(() => client.setQueryData(["calendar-workspace", "2026-10-01", "2026-11-01", "Europe/Berlin"], updated));
    await screen.findByText("Plan 2026-10-23 updated");
    await nextFrame();
    expect(scroller().scrollTop).toBe(50);
  });

  it("focuses a selected date and lets Today restore focus within the same month", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(200));
    fireEvent.change(screen.getByLabelText("Go to date"), { target: { value: "2026-10-24" } });
    await waitFor(() => expect(scroller().scrollTop).toBe(300));
    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(200));

    await userEvent.click(screen.getByRole("button", { name: "Next period" }));
    await screen.findByText("Plan 2026-11-05");
    await waitFor(() => expect(scroller().scrollTop).toBe(0));
    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(200));
  });

  it("returns to today's month when switching to Agenda from another month", async () => {
    mount("/calendar?date=2026-11-05");
    await screen.findByText("Plan 2026-11-05");
    await userEvent.click(screen.getByRole("button", { name: "Agenda" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(200));
    expect(document.querySelector(".fc-list-day.fc-day-today")).toHaveAttribute("data-date", "2026-10-23");
  });
});
