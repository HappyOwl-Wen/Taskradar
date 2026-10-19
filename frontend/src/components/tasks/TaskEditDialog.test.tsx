import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { QuickParse, TaskDetail } from "@/lib/types";
import { makeDetail } from "@/test/fixtures";
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

function wrap(children: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const renderCreate = (onOpenChange: (open: boolean) => void = () => undefined) => wrap(<TaskEditDialog open onOpenChange={onOpenChange} />);

describe("TaskEditDialog: adding a to-do", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("needs one sentence: shows what will be added and saves the recognised title, date and wording", async () => {
    const parse = vi.spyOn(api, "quickParse").mockResolvedValue(RENT);
    const create = vi.spyOn(api, "createTask").mockResolvedValue({ id: "t1" } as TaskDetail);
    renderCreate();

    // Only the sentence and the date are in view; category, priority and the rest are folded away.
    expect(screen.getByText("更多选项")).toBeInTheDocument();
    expect(screen.queryByLabelText("类别")).not.toBeVisible();

    await userEvent.type(screen.getByLabelText("待办"), "周五前交房租");
    expect(await screen.findByText(/将添加「交房租」，.*10月16日/)).toBeInTheDocument();
    expect(parse).toHaveBeenLastCalledWith("周五前交房租");
    expect(screen.getByLabelText("日期")).toHaveValue("2026-10-16");

    await userEvent.click(screen.getByRole("button", { name: "添加待办" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      title: "交房租",
      due_date: "2026-10-16",
      due_text: "周五",
      action_type: "pay",
      category: "financial",
    });
  });

  it("adds with Enter right after typing, waiting for the recognition instead of saving the raw sentence", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValue(RENT);
    const create = vi.spyOn(api, "createTask").mockResolvedValue({ id: "t1" } as TaskDetail);
    renderCreate();
    await userEvent.type(screen.getByLabelText("待办"), "周五前交房租{Enter}");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ title: "交房租", due_date: "2026-10-16" });
  });

  it("drops the original wording once the user picks another date", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValue(RENT);
    const create = vi.spyOn(api, "createTask").mockResolvedValue({ id: "t1" } as TaskDetail);
    renderCreate();

    await userEvent.type(screen.getByLabelText("待办"), "周五前交房租");
    await waitFor(() => expect(screen.getByLabelText("日期")).toHaveValue("2026-10-16"));
    const date = screen.getByLabelText("日期");
    await userEvent.clear(date);
    await userEvent.type(date, "2026-10-20");
    await userEvent.click(screen.getByRole("button", { name: "添加待办" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ due_date: "2026-10-20", due_text: null });
  });

  it("closes at once when nothing was entered", async () => {
    const onOpenChange = vi.fn();
    renderCreate(onOpenChange);
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("asks before discarding what was typed", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValue({ ...RENT, title: "Steuererklärung", due_date: null, due_text: null });
    const onOpenChange = vi.fn();
    renderCreate(onOpenChange);
    await userEvent.type(screen.getByLabelText("待办"), "Steuererklärung");
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("放弃未保存的修改？");

    await userEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("待办")).toHaveValue("Steuererklärung");

    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByRole("button", { name: "放弃更改" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("TaskEditDialog: editing a task", () => {
  const task = makeDetail({ id: "c1", title: "Formular abgeben", due_date: "2026-10-20" });

  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves only what changed, with one button", async () => {
    const update = vi.spyOn(api, "updateTask").mockResolvedValue({ ...task, title: "Formular unterschrieben abgeben" });
    const setStatus = vi.spyOn(api, "setStatus");
    const onOpenChange = vi.fn();
    wrap(<TaskEditDialog open onOpenChange={onOpenChange} task={task} />);

    expect(screen.getByRole("heading", { name: "编辑任务" })).toBeInTheDocument();
    const title = screen.getByLabelText("标题");
    await userEvent.clear(title);
    await userEvent.type(title, "Formular unterschrieben abgeben");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("c1", { title: "Formular unterschrieben abgeben" }));
    expect(setStatus).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opened from “change date”, it starts at the date", () => {
    wrap(<TaskEditDialog open onOpenChange={() => undefined} task={task} focus="date" />);
    expect(screen.getByLabelText("日期")).toHaveFocus();
  });
});
