import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/menu";
import i18n from "@/i18n";
import { TopBar } from "./TopBar";

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

  it("offers one way to add a to-do, named the same everywhere, and nothing to import", () => {
    wrap(<TopBar />);
    expect(screen.getByRole("button", { name: "添加待办" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /导入/ })).not.toBeInTheDocument();
    // Theme and language share a "more" menu on phones.
    expect(screen.getByRole("button", { name: "更多" })).toBeInTheDocument();
  });

  it("shows the system status as an icon at the top right", () => {
    wrap(<TopBar />);
    // Queries are disabled here, so the status is still being checked.
    expect(screen.getByRole("button", { name: "系统状态: 正在检查系统状态…" })).toBeInTheDocument();
  });

  it("leaves searching to the task list on the task list (one search per screen)", () => {
    wrap(<TopBar />, "/tasks");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("搜索全部任务…")).not.toBeInTheDocument();
  });
});
