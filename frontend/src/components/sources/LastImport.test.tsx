import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { api, ApiError } from "@/lib/api";
import type { ImportResult } from "@/lib/types";
import { importSummary, recordImport, useUpload } from "@/lib/upload";
import { LastImportCard } from "./LastImport";

function result(overrides: Partial<ImportResult>): ImportResult {
  return {
    filename: "file.pdf",
    status: "processed",
    created: true,
    document_id: null,
    message_id: null,
    error_code: null,
    error_message: null,
    tasks_created: 0,
    duplicates_merged: 0,
    suggestions_created: 0,
    completions_applied: 0,
    tasks_updated: 0,
    content_type: null,
    ...overrides,
  };
}

function wrap(children: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LastImportCard", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers a retry only where the same file may pass, and shows the new result in place", async () => {
    act(() =>
      recordImport([
        result({ filename: "scan.png", status: "failed", document_id: 7, error_code: "ocr_failed" }),
        result({ filename: "huge.pdf", status: "failed", created: false, error_code: "file_too_large" }),
      ]),
    );
    const reprocess = vi.spyOn(api, "reprocessDocument").mockResolvedValue(result({ filename: "scan.png", document_id: 7, tasks_created: 2 }));
    wrap(<LastImportCard />);

    const [scan, huge] = screen.getAllByRole("listitem");
    expect(within(huge).queryByRole("button", { name: /重试/ })).not.toBeInTheDocument();
    expect(within(huge).getByRole("button", { name: "换个文件重新导入" })).toBeInTheDocument();

    fireEvent.click(within(scan).getByRole("button", { name: /重试/ }));
    // The stored file is processed again (nothing is uploaded twice) and its row shows what was found.
    expect(await within(scan).findByText("发现 2 个新任务")).toBeInTheDocument();
    expect(reprocess).toHaveBeenCalledWith(7);
    expect(within(scan).queryByRole("button", { name: /重试/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /去确认/ })).toHaveAttribute("href", "/inbox");
  });
});

describe("importSummary", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("counts new tasks and suggestions in their own units, never added up", () => {
    // Two mails about one thing: two new tasks, and a duplicate suggestion between them.
    act(() =>
      recordImport([
        result({ filename: "a.eml", tasks_created: 1 }),
        result({ filename: "b.eml", tasks_created: 1, suggestions_created: 1 }),
      ]),
    );
    wrap(<LastImportCard />);
    expect(screen.getByText("发现 2 个新任务，1 条建议需要你核对")).toBeInTheDocument();
    expect(screen.queryByText(/发现 3/)).not.toBeInTheDocument();
    expect(importSummary([result({ tasks_updated: 1 }), result({ duplicates_merged: 2 })], i18n.t)).toBe("1 个已有任务有更新，2 条合并到已有任务");
    expect(importSummary([result({})], i18n.t)).toBe("没有发现需要处理的事项");
  });
});

function Uploader({ files }: { files: File[] }) {
  const upload = useUpload();
  return (
    <button type="button" onClick={() => upload.mutate(files)}>
      upload
    </button>
  );
}

describe("useUpload", () => {
  it("offers to send the same files again when the request itself failed", async () => {
    const send = vi.spyOn(api, "upload").mockRejectedValue(new ApiError(0, "network_error", "Network error"));
    const failed = vi.spyOn(toast, "error");
    const files = [new File(["%PDF-1.4"], "a.pdf", { type: "application/pdf" })];
    wrap(<Uploader files={files} />);

    fireEvent.click(screen.getByRole("button", { name: "upload" }));
    await vi.waitFor(() => expect(failed).toHaveBeenCalled());
    const options = failed.mock.calls[0][1] as { action: { label: string; onClick: () => void } };
    expect(options.action.label).toBe("重试");

    act(() => options.action.onClick());
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0]).toEqual([files[0]]);
    expect(send.mock.calls[1][0][0]).toBe(files[0]);
  });
});
