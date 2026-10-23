import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { buffersApi, type ConflictCheck } from "@/lib/buffers";
import { calendarApi, type CalendarItem, type CalendarSources } from "@/lib/calendar";
import { ItemBuffers } from "./BufferFields";
import { CalendarEditor, type EditorSeed } from "./CalendarEditor";

const sources: CalendarSources = { sources: [{ id: "personal", summary: "Personal calendar", writable: true, selected: true, primary: true, available: true, app_created: false, access_role: "owner", timezone: "Europe/Berlin", color: "blue", last_synced_at: null, last_error: null, retry_at: null }], capabilities: { connected: true, read: true, edit: true, app: true, scopes: [] }, default_calendar_id: "personal", google_edit_enabled: true };
const form = { title: "Plan", description: "", location: "", all_day: false, start: "2026-10-22T10:30", end: "2026-10-22T11:30", timezone: "Europe/Berlin" };
const overlaps: ConflictCheck = {
  conflicts: [
    { id: "google:personal:review", kind: "google", title: "Design review", start: "2026-10-22T08:00:00+00:00", end: "2026-10-22T09:00:00+00:00", source_name: "Personal calendar", color: "#4285f4", type: "overlap", minutes: 30, buffer: null },
    { id: "work:b2", kind: "work", title: "Reading", start: "2026-10-22T09:40:00+00:00", end: "2026-10-22T10:30:00+00:00", source_name: "local", color: "#4f46e5", type: "buffer", minutes: 5, buffer: { owner: "other", side: "before", kind: "prep" } },
  ],
  unchecked: ["Team"],
  suggestion: { start: "2026-10-22T10:30:00+00:00", end: "2026-10-22T11:30:00+00:00" },
};
const wrap = (children: ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
const mount = (seed: EditorSeed) => render(wrap(<CalendarEditor seed={seed} sources={sources} timezone="Europe/Berlin" onClose={vi.fn()} />));

beforeEach(async () => { await i18n.changeLanguage("en"); localStorage.clear(); });
afterEach(() => vi.restoreAllMocks());

describe("overlap warning and buffers in the calendar editor", () => {
  it("names what overlaps, says what was not checked and moves to the next free slot", async () => {
    const check = vi.spyOn(buffersApi, "conflicts").mockResolvedValue(overlaps);
    mount({ mode: "local", form });
    const notice = await screen.findByRole("status", { name: "Time overlap" });
    expect(notice).toHaveTextContent("Design review10:00–11:00 · Personal calendarOverlaps by 30 min");
    expect(notice).toHaveTextContent("Overlaps its preparation time before by 5 min");
    expect(notice).toHaveTextContent("Not checked: Team.");
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ start: "2026-10-22T10:30", end: "2026-10-22T11:30" }), []);
    // Saving is still possible: the warning never disables it.
    expect(screen.getByRole("button", { name: "Save locally" })).toBeEnabled();
    check.mockResolvedValue({ conflicts: [], unchecked: [], suggestion: null });
    await userEvent.click(within(notice).getByRole("button", { name: "Move to 12:30–13:30" }));
    expect(screen.getByLabelText("Start")).toHaveValue("2026-10-22T12:30");
    expect(screen.getByLabelText("End")).toHaveValue("2026-10-22T13:30");
    expect(await screen.findByText("Nothing else is scheduled at this time.")).toBeInTheDocument();
  });
  it("never sends times that were invalid for a moment while typing", async () => {
    const check = vi.spyOn(buffersApi, "conflicts").mockResolvedValue({ conflicts: [], unchecked: [], suggestion: null });
    mount({ mode: "local", form });
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-10-22T09:00" } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-10-22T12:00" } });
    await waitFor(() => expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ end: "2026-10-22T12:00" }), []));
    expect(check.mock.calls.map(([sent]) => sent.end)).toEqual(["2026-10-22T11:30", "2026-10-22T12:00"]);
  });
  it("saves typed buffers with a local work block and leaves the edited block out of the check", async () => {
    const check = vi.spyOn(buffersApi, "conflicts").mockResolvedValue({ conflicts: [], unchecked: [], suggestion: null });
    const save = vi.spyOn(calendarApi, "saveBlock").mockResolvedValue({} as never);
    const item = { id: "work:b1", kind: "work", work_block_id: "b1", revision: 2, title: "Plan", all_day: false, editable: true, timezone: "Europe/Berlin", start: "2026-10-22T08:30:00+00:00", end: "2026-10-22T09:30:00+00:00" } as CalendarItem;
    mount({ mode: "local", item, taskId: "task" });
    await waitFor(() => expect(check).toHaveBeenCalledWith(expect.anything(), ["work:b1"]));
    const before = screen.getByLabelText("Before (minutes)");
    await userEvent.clear(before);
    await userEvent.type(before, "30");
    await userEvent.selectOptions(screen.getByLabelText("Use before"), "commute");
    await waitFor(() => expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ buffer: { before_minutes: 30, before_kind: "commute", after_minutes: 0, after_kind: "rest" } }), ["work:b1"]));
    await userEvent.click(screen.getByRole("button", { name: "Save locally" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].buffer).toEqual({ before_minutes: 30, before_kind: "commute", after_minutes: 0, after_kind: "rest" });
  });
  it("repeats the overlap in the Google submission review", async () => {
    vi.spyOn(buffersApi, "conflicts").mockResolvedValue(overlaps);
    vi.spyOn(calendarApi, "saveDraft").mockImplementation(async (d) => d);
    const commit = vi.spyOn(calendarApi, "commit");
    mount({ mode: "google", form });
    await screen.findByRole("status", { name: "Time overlap" });
    await userEvent.click(screen.getByRole("button", { name: "Review Google submission…" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Note: this time overlaps other plans (2).");
    expect(commit).not.toHaveBeenCalled();
  });
  it("reserves time around every occurrence of a read-only recurring meeting", async () => {
    const saved = { before_minutes: 10, before_kind: "prep" as const, after_minutes: 0, after_kind: "rest" as const };
    const save = vi.spyOn(buffersApi, "save").mockResolvedValue({ buffer: { ...saved, series: true } });
    const item = { id: "google:team:w_1", kind: "google", calendar_id: "team", event_id: "w_1", title: "Team meeting", all_day: false, editable: false, remote: { id: "w_1", recurringEventId: "w" }, buffer: null } as CalendarItem;
    render(wrap(<ItemBuffers item={item} />));
    expect(screen.getByText("None")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Adjust buffer time" }));
    const before = screen.getByLabelText("Before (minutes)");
    await userEvent.clear(before);
    await userEvent.type(before, "10");
    await userEvent.click(screen.getByLabelText("Apply to every occurrence of this recurring event"));
    await userEvent.click(screen.getByRole("button", { name: "Save buffer time" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ calendar_id: "team", event_id: "w_1" }, saved, true));
    expect(await screen.findByText("10 min preparation before · from the recurring event")).toBeInTheDocument();
  });
});
