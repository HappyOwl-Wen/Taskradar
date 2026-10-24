import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { reloadCurrentPage } from "@/lib/pageLoad";
import { RouteError } from "./NotFoundPage";

vi.mock("@/lib/pageLoad", async original => ({ ...await original<typeof import("@/lib/pageLoad")>(), reloadCurrentPage: vi.fn() }));
beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("zh-CN"); });

function fail(message: string) {
  const router = createMemoryRouter([{ path: "/tasks", loader() { throw new TypeError(message); }, element: <p>Tasks</p>, errorElement: <RouteError />, HydrateFallback: () => null }], { initialEntries: ["/tasks?status=todo"] });
  render(<RouterProvider router={router} />);
  return router;
}

it.each([
  "Failed to fetch dynamically imported module: http://localhost/assets/TasksPage-old.js",
  "error loading dynamically imported module: http://localhost/assets/TasksPage-old.js",
  "Importing a module script failed.",
  "Unable to preload CSS for /assets/TasksPage-old.css",
])("offers a document reload for %s while preserving the selected page", async message => {
  const router = fail(message);
  await screen.findByText("页面暂时无法加载");
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  expect(reloadCurrentPage).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "重新加载当前页面" }));
  expect(reloadCurrentPage).toHaveBeenCalledOnce();
  expect(router.state.location.pathname + router.state.location.search).toBe("/tasks?status=todo");
});

it("continues to expose actual rendering errors instead of treating them as an outdated page", async () => {
  fail("Cannot read properties of undefined (reading 'title')");
  await screen.findByText("页面出现错误");
  expect(screen.getByText("Cannot read properties of undefined (reading 'title')")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回今天" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重新加载当前页面" })).not.toBeInTheDocument();
});
