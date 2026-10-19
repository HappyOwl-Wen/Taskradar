import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { TaskStatus, TaskSummary } from "@/lib/types";
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

  it("stays right when the same toggle receives the updated task: done, reopened, done and undone", async () => {
    const client = new QueryClient();
    const view = (task: TaskSummary) => (
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <CompleteToggle task={task} />
        </TooltipProvider>
      </QueryClientProvider>
    );
    const open = makeTask({ id: "t3", title: "Steuer abgeben", status: "confirmed" });
    const done: TaskSummary = { ...open, status: "completed" };
    const setStatus = vi.spyOn(api, "setStatus").mockImplementation(async (_id: string, status: string) => makeDetail({ ...open, status: status as TaskStatus }));
    const { rerender } = render(view(open));
    const box = () => screen.getByRole("checkbox");
    const settled = () => waitFor(() => expect(box()).toBeEnabled());

    await userEvent.click(box());
    await settled();
    expect(box()).toHaveAttribute("aria-checked", "true"); // until the list refreshes
    rerender(view(done)); // the list refreshed
    expect(box()).toHaveAttribute("aria-checked", "true");
    expect(box()).toHaveAccessibleName("把「Steuer abgeben」恢复为未完成");

    await userEvent.click(box());
    await settled();
    expect(setStatus).toHaveBeenLastCalledWith("t3", "confirmed");
    rerender(view(open));
    expect(box()).toHaveAttribute("aria-checked", "false");
    expect(box()).toHaveAccessibleName("把「Steuer abgeben」标记为已完成");

    await userEvent.click(box());
    await settled();
    rerender(view(done));
    rerender(view(open)); // undone from the toast: the task reports "confirmed" again
    expect(box()).toHaveAttribute("aria-checked", "false");
  });

  it("ticks off an unconfirmed task of an earlier version like any other", () => {
    renderToggle(makeTask({ title: "Alt", status: "candidate" }));
    expect(screen.getByRole("checkbox", { name: "把「Alt」标记为已完成" })).toBeInTheDocument();
  });

  it("is not a tick box for a dismissed task (it is restored first)", () => {
    renderToggle(makeTask({ status: "dismissed" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("已忽略")).toBeInTheDocument();
  });
});
