import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { Settings, TaskDetail } from "@/lib/types";
import { makeDetail, makeSuggestion } from "@/test/fixtures";
import { DuplicateCompare } from "./DuplicateCompare";

const incoming = makeDetail({
  id: "new",
  title: "Mietzahlung November",
  action_required: "Bitte überweisen Sie die Miete für November.",
  due_date: "2026-11-03",
  due_text: "bis 3. November",
  status: "candidate",
});
const existing = makeDetail({ id: "old", title: "Miete November überweisen", due_date: "2026-11-01", status: "confirmed" });

function renderCompare(tasks: Record<string, TaskDetail>) {
  vi.spyOn(api, "task").mockImplementation(async (id: string) => tasks[id]);
  vi.spyOn(api, "settings").mockResolvedValue({ general: { timezone: "Europe/Berlin" } } as Settings);
  const accept = vi.spyOn(api, "acceptSuggestion").mockResolvedValue({ ...existing, undo_event_id: 9 });
  const reject = vi.spyOn(api, "rejectSuggestion").mockResolvedValue({ ...incoming, undo_event_id: 10 });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter>
          <DuplicateCompare suggestion={makeSuggestion()} open onOpenChange={() => undefined} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { accept, reject };
}

describe("DuplicateCompare", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows both tasks side by side and requires a date choice when the deadlines differ", async () => {
    const user = userEvent.setup();
    const { accept } = renderCompare({ new: incoming, old: existing });
    expect((await screen.findAllByText("Miete November überweisen")).length).toBeGreaterThan(0);
    expect(screen.getByText("日期冲突")).toBeInTheDocument();
    expect(screen.getByText(/合并后保留已有任务「Miete November überweisen」/)).toBeInTheDocument();
    // Internal scores stay behind the technical details, labelled as uncalibrated.
    expect(screen.queryByText(/71%/)).not.toBeInTheDocument();

    const merge = screen.getByRole("button", { name: "合并任务" });
    expect(merge).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /改用新来源的日期/ }));
    expect(merge).toBeEnabled();
    await user.click(merge);
    expect(accept).toHaveBeenCalledWith(5, "new");
  });

  it("merges without a question when the deadlines agree", async () => {
    const user = userEvent.setup();
    const { accept } = renderCompare({ new: { ...incoming, due_date: "2026-11-01" }, old: existing });
    await screen.findAllByText("Miete November überweisen");
    expect(screen.queryByText("日期冲突")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "合并任务" }));
    expect(accept).toHaveBeenCalledWith(5, undefined);
  });

  it("can keep both tasks", async () => {
    const user = userEvent.setup();
    const { accept, reject } = renderCompare({ new: incoming, old: existing });
    await screen.findAllByText("Miete November überweisen");
    await user.click(screen.getByRole("button", { name: "保留为独立任务" }));
    expect(reject).toHaveBeenCalledWith(5);
    expect(accept).not.toHaveBeenCalled();
  });

  it("takes the new date by default when the existing task has none", async () => {
    const user = userEvent.setup();
    const { accept } = renderCompare({ new: incoming, old: { ...existing, due_date: null } });
    await screen.findAllByText("Miete November überweisen");
    expect(screen.getByRole("radio", { name: /改用新来源的日期/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "合并任务" }));
    expect(accept).toHaveBeenCalledWith(5, "new");
  });
});
