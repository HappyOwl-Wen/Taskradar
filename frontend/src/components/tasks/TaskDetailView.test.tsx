import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { Settings, SystemStatus } from "@/lib/types";
import { makeDetail } from "@/test/fixtures";
import { TaskDetailView } from "./TaskDetailView";

describe("TaskDetailView: adding notes", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the notes ready to type and saves them with Ctrl+Enter", async () => {
    let task = makeDetail();
    vi.spyOn(api, "task").mockImplementation(async () => task);
    vi.spyOn(api, "settings").mockResolvedValue({ general: { timezone: "Europe/Berlin" } } as Settings);
    vi.spyOn(api, "systemStatus").mockResolvedValue({ google: { calendar_connected: false } } as SystemStatus);
    const update = vi.spyOn(api, "updateTask").mockImplementation(async (_id, patch) => {
      task = { ...task, description: patch.description ?? task.description };
      return task;
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <MemoryRouter>
            <TaskDetailView taskId={task.id} />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "＋ 添加备注" }));
    const notes = screen.getByRole("textbox", { name: "说明" });
    expect(notes).toBeVisible();
    expect(notes).toHaveFocus();

    await userEvent.keyboard("第一行{Enter}第二行");
    expect(notes).toHaveValue("第一行\n第二行");
    expect(update).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(task.id, { description: "第一行\n第二行" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("第一行 第二行")).toBeVisible();
  });
});
