import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { TopBar, UploadButton } from "./TopBar";

function wrap(children: React.ReactNode, path = "/") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={children} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("TopBar", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("names the import button even when only its icon is shown", () => {
    wrap(<UploadButton />);
    expect(screen.getByRole("button", { name: "导入文件" })).toBeInTheDocument();
  });

  it("offers one way to add a to-do, named the same everywhere", () => {
    wrap(<TopBar />);
    expect(screen.getByRole("button", { name: "添加待办" })).toBeInTheDocument();
    // Theme and language share a "more" menu on phones.
    expect(screen.getByRole("button", { name: "更多" })).toBeInTheDocument();
  });

  it("leaves searching to the task list on the task list (one search per screen)", () => {
    wrap(<TopBar />, "/tasks");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("搜索全部任务…")).not.toBeInTheDocument();
  });
});
