import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MouseEvent } from "react";
import { toast, type Action } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { Settings } from "@/lib/types";
import { makeDetail } from "@/test/fixtures";
import { DeleteTasksDialog } from "./DeleteTaskDialog";

describe("Moving tasks to the recycle bin", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    vi.spyOn(api, "settings").mockResolvedValue({ calendar: { remove_on_dismiss: false } } as Settings);
  });
  afterEach(() => vi.restoreAllMocks());

  it("explains retention and offers immediate undo after deleting", async () => {
    vi.spyOn(api, "deleteTask").mockResolvedValue({ deleted: "one", undo_event_id: 42 });
    const undo = vi.spyOn(api, "undo").mockResolvedValue(makeDetail());
    const success = vi.spyOn(toast, "success");
    const close = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><DeleteTasksDialog ids={["one"]} title="需要保留的任务" open onOpenChange={close} /></QueryClientProvider>);
    expect(screen.getByText(/保留 30 天/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("已将 1 项任务移入回收站", expect.objectContaining({ action: expect.objectContaining({ label: "撤销" }) })));
    const action = success.mock.calls[0][1]?.action as Action;
    action.onClick({} as MouseEvent<HTMLButtonElement>);
    await waitFor(() => expect(undo).toHaveBeenCalledWith(42));
    expect(close).toHaveBeenCalledWith(false);
  });
});
