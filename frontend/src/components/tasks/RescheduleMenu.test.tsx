import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster, toast } from "sonner";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { api, type RescheduleResult } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Settings } from "@/lib/types";
import { RescheduleMenu } from "./RescheduleMenu";

function result(overrides: Partial<RescheduleResult> = {}): RescheduleResult {
  return { changed: ["a", "b"], count: 2, due_date: "2026-10-23", undo_event_ids: [5, 6], skipped: [], calendar_outdated: [], ...overrides };
}

function renderMenu(ids = ["a", "b"]) {
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RescheduleMenu ids={ids} onDone={onDone} />
      <Toaster />
    </QueryClientProvider>,
  );
  return onDone;
}

const day = (date: string) => formatDate(date, "zh-CN", 2026);

describe("RescheduleMenu", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  beforeEach(() => {
    // Thursday 22 October 2026, noon in Berlin. Only the date is fixed: timers run as usual.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-22T10:00:00Z") });
    vi.spyOn(api, "settings").mockResolvedValue({ general: { timezone: "Europe/Berlin" } } as Settings);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Toasts live in a module-level store: clear them so one test cannot see another's.
    toast.dismiss();
    await waitFor(() => expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0));
  });

  it("shows tomorrow and next week as dates and moves the whole selection in one click", async () => {
    const move = vi.spyOn(api, "rescheduleTasks").mockImplementation(async (_ids, dueDate) => result({ due_date: dueDate }));
    const onDone = renderMenu();
    await userEvent.click(screen.getByRole("button", { name: "改期" }));
    const menu = await screen.findByRole("dialog", { name: "把 2 项任务改到" });
    expect(within(menu).getByRole("button", { name: /^明天/ })).toHaveTextContent(day("2026-10-23"));
    const nextWeek = within(menu).getByRole("button", { name: /^下周/ });
    expect(nextWeek).toHaveTextContent(day("2026-10-26")); // its Monday

    await userEvent.click(nextWeek);
    await waitFor(() => expect(move).toHaveBeenCalledWith(["a", "b"], "2026-10-26"));
    expect(await screen.findByText(`已将 2 项任务改到 ${day("2026-10-26")}。`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销" })).toBeInTheDocument();
    expect(onDone).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("moves to a chosen day and says which tasks kept their date", async () => {
    const move = vi.spyOn(api, "rescheduleTasks").mockResolvedValue(
      result({
        changed: ["a"],
        count: 1,
        due_date: "2026-10-25",
        undo_event_ids: [5],
        skipped: [
          { id: "b", title: "Nachtzug", reason: "ambiguous_time" },
          { id: "c", title: "Formular", reason: "closed" },
        ],
        calendar_outdated: ["a"],
      }),
    );
    renderMenu(["a", "b", "c"]);
    await userEvent.click(screen.getByRole("button", { name: "改期" }));
    const apply = await screen.findByRole("button", { name: "改到这天" });
    expect(apply).toBeDisabled(); // nothing chosen yet
    fireEvent.change(screen.getByLabelText("指定日期"), { target: { value: "2026-10-25" } });
    await userEvent.click(apply);

    await waitFor(() => expect(move).toHaveBeenCalledWith(["a", "b", "c"], "2026-10-25"));
    const date = day("2026-10-25");
    expect(
      await screen.findByText(`已将 1 项任务改到 ${date}。 1 项已完成或已忽略的任务保留原日期。 其中 1 项在 Google 日历中，请在任务中更新日历。`),
    ).toBeInTheDocument();
    expect(await screen.findByText(`「Nachtzug」没有改期：因为夏令时切换，它的时间在 ${date} 不存在或会出现两次。请在任务中设置日期和时间。`)).toBeInTheDocument();
  });

  it("shows the spinner on the day that was clicked while the move runs", async () => {
    let finish: (r: RescheduleResult) => void = () => {};
    vi.spyOn(api, "rescheduleTasks").mockImplementation(
      () =>
        new Promise<RescheduleResult>((resolve) => {
          finish = resolve;
        }),
    );
    renderMenu();
    await userEvent.click(screen.getByRole("button", { name: "改期" }));
    await userEvent.click(await screen.findByRole("button", { name: /^下周/ }));
    expect(screen.getByRole("button", { name: /^下周/ })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: /^明天/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "改到这天" })).not.toHaveAttribute("aria-busy");
    finish(result({ due_date: "2026-10-26" }));
    expect(await screen.findByText(`已将 2 项任务改到 ${day("2026-10-26")}。`)).toBeInTheDocument();
  });

  it("says so when the tasks were already due that day, without an undo", async () => {
    vi.spyOn(api, "rescheduleTasks").mockResolvedValue(result({ changed: [], count: 0, undo_event_ids: [] }));
    renderMenu();
    await userEvent.click(screen.getByRole("button", { name: "改期" }));
    await userEvent.click(await screen.findByRole("button", { name: /^明天/ }));
    expect(await screen.findByText(`所选任务本来就在 ${day("2026-10-23")}。`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();
  });
});
