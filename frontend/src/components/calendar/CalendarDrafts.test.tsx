import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ApiError } from "@/lib/api";
import { calendarApi, type CalendarDraft, type CalendarView } from "@/lib/calendar";
import { loadRecovery, RECOVERY_KEY } from "@/lib/calendarRecovery";
import { CalendarDrafts } from "./CalendarDrafts";

const form = { title: "Research seminar", description: "Notes to keep", location: "", all_day: false, start: "2026-11-11T18:00", end: "2026-11-11T19:30", timezone: "Europe/Berlin" };
const draft: CalendarDraft = { id: "11111111-2222-4333-8444-555555555555", operation: "create", calendar_id: "personal", payload: form, base_event: {}, status: "failed", last_error: "permanent_error" };
let view: CalendarView;
function Fixture() {
  const { data } = useQuery({ queryKey: ["calendar-workspace", "current"], queryFn: async () => view, initialData: view, staleTime: Infinity });
  const [recovery, setRecovery] = useState(loadRecovery);
  return <CalendarDrafts drafts={data.drafts} sources={data.sources} recovery={recovery} onEdit={vi.fn()} onRecoveryChange={setRecovery} />;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["calendar-workspace", "other-range"], view);
  render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>);
  return client;
}
const openDelete = (name = form.title) => userEvent.click(screen.getByRole("button", { name: `Delete draft: ${name}` }));
const confirmDelete = () => userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete draft" }));

beforeEach(async () => {
  await i18n.changeLanguage("en"); localStorage.clear();
  view = { drafts: [draft], items: [], sources: [], unscheduled: [], capabilities: { connected: false, read: false, edit: false, app: false, scopes: [] }, default_calendar_id: null, google_edit_enabled: false, window_updated: {}, timezone: "Europe/Berlin" };
  vi.spyOn(calendarApi, "resolve").mockImplementation(async id => { view = { ...view, drafts: view.drafts.filter(item => item.id !== id) }; return {} as never; });
});
afterEach(() => vi.restoreAllMocks());

describe("calendar draft deletion", () => {
  it("requires confirmation and cancel keeps the draft", async () => {
    mount(); await openDelete();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(form.title);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Existing Google events, local tasks and work blocks are kept.");
    expect(calendarApi.resolve).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Delete draft: ${form.title}` })).toBeInTheDocument();
    expect(calendarApi.resolve).not.toHaveBeenCalled();
  });

  it("removes only the confirmed draft from every cached range and clears its recovery copy", async () => {
    const other = { ...draft, id: "other", payload: { ...form, title: "Other draft" } };
    view = { ...view, drafts: [draft, other] };
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ mode: "google", id: draft.id, draft, form }));
    const client = mount(); await openDelete(); await confirmDelete();
    await waitFor(() => expect(screen.queryByRole("button", { name: `Delete draft: ${form.title}` })).not.toBeInTheDocument());
    expect(calendarApi.resolve).toHaveBeenCalledExactlyOnceWith(draft.id, "discard");
    expect(localStorage.getItem(RECOVERY_KEY)).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore unfinished input" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete draft: Other draft" })).toBeInTheDocument();
    expect(client.getQueryData<CalendarView>(["calendar-workspace", "other-range"])?.drafts).toEqual([other]);
  });

  it("preserves recovery input belonging to another draft", async () => {
    const recovery = JSON.stringify({ mode: "google", id: "unrelated", form: { ...form, title: "Unrelated input" } });
    localStorage.setItem(RECOVERY_KEY, recovery);
    mount(); await openDelete(); await confirmDelete();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(localStorage.getItem(RECOVERY_KEY)).toBe(recovery);
    expect(screen.getByRole("button", { name: "Restore unfinished input" })).toBeInTheDocument();
  });

  it("deletes unfinished browser input locally without submitting a Google operation", async () => {
    view = { ...view, drafts: [] };
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ mode: "google", id: "browser-only", form }));
    mount(); await openDelete(); await confirmDelete();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsubmitted Google operations" })).not.toBeInTheDocument());
    expect(calendarApi.resolve).not.toHaveBeenCalled();
    expect(localStorage.getItem(RECOVERY_KEY)).toBeNull();
  });

  it("keeps the draft and recovery input when deletion fails", async () => {
    vi.mocked(calendarApi.resolve).mockRejectedValue(new Error("Offline"));
    const recovery = JSON.stringify({ mode: "google", id: draft.id, draft, form });
    localStorage.setItem(RECOVERY_KEY, recovery);
    mount(); await openDelete(); await confirmDelete();
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(localStorage.getItem(RECOVERY_KEY)).toBe(recovery);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: `Delete draft: ${form.title}` })).toBeInTheDocument();
  });

  it("cleans up a stale row when the draft was already deleted in another window", async () => {
    vi.mocked(calendarApi.resolve).mockImplementation(async () => { view = { ...view, drafts: [] }; throw new ApiError(404, "not_found", "Draft not found"); });
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ mode: "google", id: draft.id, draft, form }));
    mount(); await openDelete(); await confirmDelete();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unsubmitted Google operations" })).not.toBeInTheDocument());
    expect(localStorage.getItem(RECOVERY_KEY)).toBeNull();
  });
});
