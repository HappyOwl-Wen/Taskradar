import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { SystemStatus } from "@/lib/types";
import { OcrBacklogNotice } from "./OcrBacklogNotice";

function mockStatus(ocr: Partial<SystemStatus["ocr"]>) {
  const status = { ocr: { engine: "tesseract", available: false, languages: [], version: null, backlog: 0, reprocessing: false, ...ocr } };
  vi.spyOn(api, "systemStatus").mockResolvedValue(status as SystemStatus);
}

function renderNotice() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OcrBacklogNotice />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OcrBacklogNotice", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays hidden when every file has been read", async () => {
    mockStatus({ available: true, backlog: 0 });
    const { container } = renderNotice();
    await vi.waitFor(() => expect(api.systemStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("points to the install instructions while OCR is missing", async () => {
    mockStatus({ available: false, backlog: 13 });
    renderNotice();
    expect(await screen.findByText(/有 13 个文件包含图片或扫描页/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "安装说明" })).toHaveAttribute("href", "/settings#system");
    expect(screen.queryByRole("button", { name: /立即识别/ })).not.toBeInTheDocument();
  });

  it("starts reading the files again once OCR is available", async () => {
    mockStatus({ available: true, backlog: 13 });
    const reprocess = vi.spyOn(api, "reprocessOcrBacklog").mockResolvedValue({ accepted: true, count: 13, job: null });
    renderNotice();
    expect(await screen.findByText(/有 13 个文件是在 OCR 可用之前导入的/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /立即识别/ }));
    expect(reprocess).toHaveBeenCalledTimes(1);
  });

  it("shows progress instead of a button while the job runs", async () => {
    mockStatus({ available: true, backlog: 5, reprocessing: true });
    renderNotice();
    expect(await screen.findByText("正在识别图片和扫描页中的文字…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
