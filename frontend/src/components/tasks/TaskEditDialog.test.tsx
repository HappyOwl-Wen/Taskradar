import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { QuickParse, TaskDetail } from "@/lib/types";
import { TaskEditDialog } from "./TaskEditDialog";

const RENT: QuickParse = {
  title: "交房租",
  category: "financial",
  action_type: "pay",
  due_date: "2026-10-16",
  due_time: null,
  due_text: "周五",
  time_semantics: "deadline",
  ambiguous: false,
  alternatives: [],
};

function renderCreate() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskEditDialog open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  );
}

describe("TaskEditDialog quick entry", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fills the form from one line and saves the user's own wording of the date", async () => {
    const parse = vi.spyOn(api, "quickParse").mockResolvedValue(RENT);
    const create = vi.spyOn(api, "createTask").mockResolvedValue({ id: "t1" } as TaskDetail);
    renderCreate();

    await userEvent.type(screen.getByLabelText(/快速输入/), "周五前交房租");
    await waitFor(() => expect(screen.getByLabelText("标题")).toHaveValue("交房租"));
    expect(parse).toHaveBeenLastCalledWith("周五前交房租");
    expect(screen.getByLabelText("日期")).toHaveValue("2026-10-16");
    expect(screen.getByText(/识别到：/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      title: "交房租",
      due_date: "2026-10-16",
      due_text: "周五",
      action_type: "pay",
      category: "financial",
    });
  });

  it("drops the original wording once the user picks another date", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValue(RENT);
    const create = vi.spyOn(api, "createTask").mockResolvedValue({ id: "t1" } as TaskDetail);
    renderCreate();

    await userEvent.type(screen.getByLabelText(/快速输入/), "周五前交房租");
    await waitFor(() => expect(screen.getByLabelText("日期")).toHaveValue("2026-10-16"));
    const date = screen.getByLabelText("日期");
    await userEvent.clear(date);
    await userEvent.type(date, "2026-10-20");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ due_date: "2026-10-20", due_text: null });
  });
});
