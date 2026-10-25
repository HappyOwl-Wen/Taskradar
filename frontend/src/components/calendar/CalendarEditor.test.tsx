import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ApiError } from "@/lib/api";
import { calendarApi, type CalendarSources } from "@/lib/calendar";
import { CalendarEditor, RECOVERY_KEY, type EditorSeed } from "./CalendarEditor";

const sources: CalendarSources = { sources: [{ id: "personal", summary: "Personal calendar", writable: true, selected: true, primary: true, available: true, app_created: false, access_role: "owner", timezone: "Europe/Berlin", color: "blue", last_synced_at: null, last_error: null, retry_at: null }], capabilities: { connected: true, read: true, edit: true, app: true, scopes: [] }, default_calendar_id: "personal", google_edit_enabled: true };
const form = { title: "Preserve my input", description: "Notes", location: "Desk", all_day: false, start: "2026-10-22T10:00", end: "2026-10-22T11:00", timezone: "Europe/Berlin" };
function mount(seed: EditorSeed) {
  const close = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><CalendarEditor seed={seed} sources={sources} timezone="Europe/Berlin" onClose={close} /></QueryClientProvider>);
  return close;
}
beforeEach(async () => { await i18n.changeLanguage("en"); localStorage.clear(); });
afterEach(() => vi.restoreAllMocks());

describe("calendar editor", () => {
  it("deletes the open draft after confirmation without saving or committing it again", async () => {
    const resolve = vi.spyOn(calendarApi, "resolve").mockResolvedValue({} as never);
    const save = vi.spyOn(calendarApi, "saveDraft"), commit = vi.spyOn(calendarApi, "commit");
    const id = "11111111-2222-4333-8444-555555555555";
    const close = mount({ mode: "google", id, form });
    await userEvent.click(screen.getByRole("button", { name: "Delete draft" }));
    expect(resolve).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(form.title);
    await userEvent.click(screen.getAllByRole("button", { name: "Delete draft" }).at(-1)!);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(resolve).toHaveBeenCalledExactlyOnceWith(id, "discard");
    expect(localStorage.getItem(RECOVERY_KEY)).toBeNull();
    expect(save).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });
  it("saves a linked local work block with explicit duration and no deadline mutation", async () => {
    const save = vi.spyOn(calendarApi, "saveBlock").mockResolvedValue({} as never);
    const close = mount({ mode: "local", taskId: "task", form });
    expect(screen.getByText("Elapsed duration: 60 minutes", { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save locally" }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith(form, "task", undefined);
    expect(localStorage.getItem(RECOVERY_KEY)).toBeNull();
  });
  it("requires a target preview and retains typed data after Google fails", async () => {
    vi.spyOn(calendarApi, "saveDraft").mockImplementation(async (d) => d);
    const commit = vi.spyOn(calendarApi, "commit").mockRejectedValue(new ApiError(502, "transient_error", "Offline"));
    const close = mount({ mode: "google", form });
    await userEvent.click(screen.getByRole("button", { name: "Review Google submission…" }));
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Personal calendar");
    await userEvent.click(screen.getByRole("button", { name: "Confirm submission" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Title")).toHaveValue("Preserve my input");
    expect(localStorage.getItem(RECOVERY_KEY)).toContain("Preserve my input");
    expect(close).not.toHaveBeenCalled();
  });
  it("shows both conflict versions and does not offer blind retry", async () => {
    vi.spyOn(calendarApi, "saveDraft").mockImplementation(async (d) => d);
    vi.spyOn(calendarApi, "commit").mockRejectedValue(new ApiError(409, "event_conflict", "Changed", true, { remote: { id: "e", etag: "new", summary: "Google version", start: { dateTime: "2026-10-22T12:00:00+02:00" }, end: { dateTime: "2026-10-22T13:00:00+02:00" } } }));
    mount({ mode: "google", form });
    await userEvent.click(screen.getByRole("button", { name: "Review Google submission…" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm submission" }));
    await screen.findByText("Google version");
    expect(screen.getByText("Your input")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review Google submission…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep my input and review again" })).toBeEnabled();
  });
});
