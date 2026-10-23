import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { SidebarWeek } from "./SidebarWeek";

vi.mock("@/lib/hooks", () => ({ useTimezone: () => "Europe/Berlin" }));

describe("sidebar calendar shortcuts", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T22:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("uses the configured timezone and links each date to the calendar", () => {
    render(<MemoryRouter><SidebarWeek /></MemoryRouter>);
    const today = screen.getByRole("link", { name: "Saturday, October 24, 2026" });
    expect(today).toHaveAttribute("aria-current", "date");
    expect(today).toHaveAttribute("href", "/calendar?date=2026-10-24&view=timeGridDay");
    expect(screen.getByRole("link", { name: "Monday, October 19, 2026" })).toHaveAttribute("href", "/calendar?date=2026-10-19&view=timeGridDay");
  });

  it("marks the selected calendar date while keeping today identifiable", () => {
    render(<MemoryRouter initialEntries={["/calendar?date=2026-10-23&view=timeGridDay"]}><SidebarWeek /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Friday, October 23, 2026" })).toHaveAttribute("aria-current", "date");
    const today = screen.getByRole("link", { name: "Saturday, October 24, 2026" });
    expect(today).not.toHaveAttribute("aria-current");
    expect(today).toHaveAttribute("data-today", "true");
  });

  it("moves the today marker when the configured timezone crosses midnight", () => {
    vi.setSystemTime(new Date("2026-10-23T21:59:45Z"));
    render(<MemoryRouter><SidebarWeek /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Friday, October 23, 2026" })).toHaveAttribute("aria-current", "date");
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("link", { name: "Saturday, October 24, 2026" })).toHaveAttribute("aria-current", "date");
    expect(screen.getByRole("link", { name: "Friday, October 23, 2026" })).not.toHaveAttribute("aria-current");
  });
});
