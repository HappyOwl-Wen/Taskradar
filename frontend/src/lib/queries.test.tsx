import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { api } from "./api";
import { useAction } from "./queries";
import type { TaskDetail } from "./types";

function Harness({ undoIds }: { undoIds: number[] }) {
  const action = useAction(async () => ({ undo_event_ids: undoIds }), {
    success: "已忽略 2 项任务",
    undo: (r) => r.undo_event_ids,
  });
  return (
    <button type="button" onClick={() => action.mutate(undefined)} disabled={action.isPending}>
      go
    </button>
  );
}

function renderHarness(undoIds: number[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness undoIds={undoIds} />
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("useAction with undo", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    // Toasts live in a module-level store: clear them so one test cannot see another's.
    toast.dismiss();
    await waitFor(() => expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0));
  });

  it("offers Undo in the success toast and reverts the recorded events newest first", async () => {
    const undo = vi.spyOn(api, "undo").mockResolvedValue({} as TaskDetail);
    renderHarness([11, 12]);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText("已忽略 2 项任务")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(undo).toHaveBeenCalledTimes(2));
    expect(undo.mock.calls.map((c) => c[0])).toEqual([12, 11]);
    expect(await screen.findByText("已撤销")).toBeInTheDocument();
  });

  it("does not offer Undo when nothing was changed", async () => {
    renderHarness([]);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText("已忽略 2 项任务")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();
  });

  it("shows a failed undo instead of pretending it worked", async () => {
    vi.spyOn(api, "undo").mockRejectedValue(new Error("之后已有其他修改，无法直接撤销。"));
    renderHarness([7]);
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    expect(await screen.findByText("之后已有其他修改，无法直接撤销。")).toBeInTheDocument();
    expect(screen.queryByText("已撤销")).not.toBeInTheDocument();
  });
});
