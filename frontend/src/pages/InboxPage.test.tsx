import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { Settings, TaskSummary } from "@/lib/types";
import { makeDetail, makeTask } from "@/test/fixtures";
import InboxPage from "./InboxPage";

const day = (date: string) => ({ due_date: date, effective_deadline: `${date}T21:59:59+00:00` });

const later = makeTask({ id: "later", title: "Später einreichen", ...day("2026-12-01"), urgency: "normal", detected_at: "2026-10-14T09:00:00+00:00" });
const overdue = makeTask({ id: "overdue", title: "Bücher zurückgeben", ...day("2026-10-10"), urgency: "overdue" });
const unclear = makeTask({ id: "unclear", title: "Register for only", needs_review: true, review_reasons: ["title_incomplete"] });

let candidates: TaskSummary[] = [];

function renderInbox(path = "/inbox") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/inbox" element={<InboxPage />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("InboxPage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  beforeEach(() => {
    // A wide window: list and detail side by side.
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({ matches: query.includes("min-width: 1024px"), addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList,
    );
    candidates = [later, unclear, overdue];
    vi.spyOn(api, "tasks").mockImplementation(async () => ({ items: candidates, total: candidates.length }));
    vi.spyOn(api, "suggestions").mockResolvedValue({ items: [] });
    vi.spyOn(api, "settings").mockResolvedValue({ general: { timezone: "Europe/Berlin" } } as Settings);
    vi.spyOn(api, "task").mockImplementation(async (id: string) => {
      const summary = candidates.find((t) => t.id === id) ?? makeTask({ id });
      return makeDetail({ ...summary, action_required: `${summary.title} (Details)` });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("orders candidates by handling priority and shows the first one next to the list", async () => {
    renderInbox();
    const list = await screen.findByRole("list", { name: "候选任务" });
    await waitFor(() => expect(within(list).getAllByRole("button", { name: /./ }).length).toBeGreaterThan(0));
    const titles = within(list)
      .getAllByRole("button")
      .filter((b) => b.id.startsWith("inbox-item-"))
      .map((b) => b.textContent);
    expect(titles).toEqual(["Bücher zurückgeben", "Register for only", "Später einreichen"]);
    expect(await screen.findByRole("heading", { level: 2, name: "Bücher zurückgeben" })).toBeInTheDocument();
    expect(screen.getByText("内容待核实")).toBeInTheDocument();
  });

  it("moves through the list with the arrow keys", async () => {
    renderInbox();
    const first = await screen.findByRole("button", { name: "Bücher zurückgeben" });
    await waitFor(() => expect(first).toHaveAttribute("aria-current", "true"));
    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Register for only" })).toHaveAttribute("aria-current", "true"));
    expect(await screen.findByRole("heading", { level: 2, name: "Register for only" })).toBeInTheDocument();
  });

  it("goes on to the next task after a decision, with an undo offered", async () => {
    const setStatus = vi.spyOn(api, "setStatus").mockImplementation(async (id: string) => {
      candidates = candidates.filter((t) => t.id !== id);
      return { ...makeDetail({ ...overdue, status: "confirmed" }), undo_event_id: 42 } as Awaited<ReturnType<typeof api.setStatus>>;
    });
    renderInbox();
    await screen.findByRole("heading", { level: 2, name: "Bücher zurückgeben" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认任务" }));
    });
    expect(setStatus).toHaveBeenCalledWith("overdue", "confirmed");
    // The next task in the list is shown, not the top of the list.
    expect(await screen.findByRole("heading", { level: 2, name: "Register for only" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Bücher zurückgeben" })).not.toBeInTheDocument());
  });
});
