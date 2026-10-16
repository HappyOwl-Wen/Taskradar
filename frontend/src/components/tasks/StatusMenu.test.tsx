import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { TaskSummary } from "@/lib/types";
import { makeDetail, makeTask } from "@/test/fixtures";
import { CompleteToggle } from "./StatusMenu";

function renderToggle(task: TaskSummary, onLeaving?: (leaving: boolean) => void) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <CompleteToggle task={task} onLeaving={onLeaving} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("CompleteToggle", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ticks an open task off in one click and lets the list fade it out", async () => {
    const task = makeTask({ id: "t1", title: "Miete zahlen", status: "confirmed" });
    const setStatus = vi.spyOn(api, "setStatus").mockResolvedValue(makeDetail({ ...task, status: "completed", undo_event_id: 7 }));
    const leaving = vi.fn();
    renderToggle(task, leaving);
    const toggle = screen.getByRole("checkbox", { name: "把「Miete zahlen」标记为已完成" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith("t1", "completed"));
    expect(leaving).toHaveBeenCalledWith(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("unticks a completed task", async () => {
    const task = makeTask({ id: "t2", title: "Bericht abgeben", status: "completed" });
    const setStatus = vi.spyOn(api, "setStatus").mockResolvedValue(makeDetail({ ...task, status: "confirmed" }));
    renderToggle(task);
    await userEvent.click(screen.getByRole("checkbox", { name: "把「Bericht abgeben」恢复为未完成" }));
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith("t2", "confirmed"));
  });

  it("is not a tick box for tasks that cannot be completed yet", () => {
    renderToggle(makeTask({ status: "candidate" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("待确认")).toBeInTheDocument();
  });
});
