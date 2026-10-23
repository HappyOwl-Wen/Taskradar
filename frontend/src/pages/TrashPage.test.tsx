import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { api, ApiError } from "@/lib/api";
import type { Settings, TrashedTask } from "@/lib/types";
import TrashPage from "./TrashPage";

const task = (id: string, title: string): TrashedTask => ({
  id, title, description: "保留的备注", status: "waiting_for_reply", category: "personal",
  due_date: "2026-10-25", due_time: null, deleted_at: "2026-10-20T08:00:00+00:00",
  expires_at: "2026-11-19T08:00:00+00:00", days_remaining: 28,
});

let items: TrashedTask[];

function renderTrash(path = "/trash") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><TrashPage /></MemoryRouter></QueryClientProvider>);
}

describe("Task recycle bin", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    items = [task("rent", "交房租"), task("tax", "提交税单")];
    vi.spyOn(api, "settings").mockResolvedValue({ general: { timezone: "Europe/Berlin" } } as Settings);
    vi.spyOn(api, "trash").mockImplementation(async (query = {}) => ({
      items: items.filter((item) => !query.q || item.title.includes(query.q)), total: items.length, retention_days: 30,
    }));
    vi.spyOn(api, "restoreTasks").mockImplementation(async (ids) => {
      items = items.filter((item) => !ids.includes(item.id));
      return { changed: ids, count: ids.length };
    });
    vi.spyOn(api, "purgeTasks").mockImplementation(async (ids) => {
      items = items.filter((item) => !ids.includes(item.id));
      return { changed: ids, count: ids.length };
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("shows the retained notes, original status and time left, and restores a task", async () => {
    renderTrash();
    const list = await screen.findByRole("list", { name: "回收站" });
    expect(within(list).getAllByText("原状态：等待回复")).toHaveLength(2);
    expect(within(list).getAllByText("剩余 28 天")).toHaveLength(2);
    expect(within(list).getAllByText("保留的备注")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "恢复「交房租」" }));
    await waitFor(() => expect(screen.queryByText("交房租")).not.toBeInTheDocument());
    expect(api.restoreTasks).toHaveBeenCalledWith(["rent"]);
    expect(screen.getByText("提交税单")).toBeInTheDocument();
  });

  it("supports batch restoration and clears the selection after refreshing", async () => {
    renderTrash();
    await userEvent.click(await screen.findByRole("checkbox", { name: "选择本页所有任务" }));
    await userEvent.click(screen.getByRole("button", { name: "恢复所选" }));
    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
    expect(api.restoreTasks).toHaveBeenCalledWith(["rent", "tax"]);
  });

  it("only permanently deletes after confirming a dialog that names the selected task", async () => {
    renderTrash();
    await userEvent.click(await screen.findByRole("button", { name: "彻底删除「交房租」" }));
    const dialog = await screen.findByRole("alertdialog", { name: "彻底删除这 1 项任务？" });
    expect(within(dialog).getByText("交房租")).toBeInTheDocument();
    expect(within(dialog).queryByText("提交税单")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/无法恢复/)).toBeInTheDocument();
    expect(api.purgeTasks).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(api.purgeTasks).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox", { name: "选择「交房租」" }));
    await userEvent.click(screen.getByRole("button", { name: "彻底删除所选…" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "彻底删除" }));
    await waitFor(() => expect(screen.queryByText("交房租")).not.toBeInTheDocument());
    expect(api.purgeTasks).toHaveBeenCalledWith(["rent"]);
  });

  it("searches independently from the active task list and clears old selections", async () => {
    renderTrash();
    await userEvent.click(await screen.findByRole("checkbox", { name: "选择「交房租」" }));
    await userEvent.type(screen.getByRole("textbox", { name: "搜索回收站…" }), "提交");
    await waitFor(() => expect(api.trash).toHaveBeenLastCalledWith({ q: "提交", offset: 0 }));
    expect(screen.getByRole("button", { name: "恢复所选" })).toBeDisabled();
    expect(screen.getByText("提交税单")).toBeInTheDocument();
  });

  it("shows recoverable errors without dropping the task", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("error");
    vi.mocked(api.restoreTasks).mockRejectedValue(new ApiError(404, "task_trash_expired", "Expired"));
    renderTrash();
    await userEvent.click(await screen.findByRole("button", { name: "恢复「交房租」" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("任务已超过 30 天保留期，无法恢复。"));
    expect(screen.getByText("交房租")).toBeInTheDocument();
  });

  it("explains the retention period when empty and allows navigating back", async () => {
    items = [];
    renderTrash();
    expect(await screen.findByText("回收站是空的")).toBeInTheDocument();
    expect(screen.getByText(/删除的任务保留 30 天/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回全部任务" })).toHaveAttribute("href", "/tasks");
  });

  it("paginates large bins without selecting tasks on another page", async () => {
    vi.mocked(api.trash).mockImplementation(async (query = {}) => ({ items, total: 101, retention_days: 30, ...query }));
    renderTrash();
    await userEvent.click(await screen.findByRole("checkbox", { name: "选择本页所有任务" }));
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(api.trash).toHaveBeenLastCalledWith({ q: undefined, offset: 100 }));
    expect(screen.getByRole("button", { name: "恢复所选" })).toBeDisabled();
    expect(screen.getByText("第 2 页")).toBeInTheDocument();
  });

  it("renders the English actions and retention copy", async () => {
    await i18n.changeLanguage("en");
    renderTrash();
    expect(await screen.findByRole("heading", { name: "Recycle bin" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Restore “交房租”" })).toBeInTheDocument();
    expect(screen.getByText(/Deleted tasks stay here for 30 days/)).toBeInTheDocument();
  });
});
