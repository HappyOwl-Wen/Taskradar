import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type { QuickParse } from "@/lib/types";
import { makeDetail } from "@/test/fixtures";
import { TaskEditDialog } from "./TaskEditDialog";

const basic: QuickParse = {
  title: "交作业", category: "academic", action_type: "submit", due_date: "2026-10-23", due_time: "20:00",
  due_text: "后天晚上8点", time_semantics: "deadline", ambiguous: false, alternatives: [], timezone: "Europe/Berlin",
};
const ambiguous: QuickParse = {
  ...basic, title: "大大后天交作业", due_date: null, due_time: null, ambiguous: true,
  temporal: {
    status: "inferred", precision: "date", normalized_date: null, normalized_time: null,
    original_expression: "大大后天", confidence: 0.55, needs_confirmation: true, explanation: ["exaggerated_modifier"],
    candidates: [{ normalized_date: "2026-10-25", normalized_time: null, range_start: null, range_end: null,
      original_expression: "大大后天", start: 0, end: 4, role: "unspecified", confidence: 0.55,
      explanation: ["exaggerated_modifier"], selectable: true }],
  },
};

function setup() {
  const create = vi.spyOn(api, "createTask").mockResolvedValue(makeDetail());
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><TaskEditDialog open onOpenChange={() => undefined} /></MemoryRouter></QueryClientProvider>);
  return { create, input: screen.getByLabelText("待办"), date: screen.getByLabelText("日期"), time: screen.getByLabelText("时间") };
}

describe("quick entry temporal states", () => {
  beforeAll(async () => { await i18n.changeLanguage("zh-CN"); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("keeps date and time overrides independent across new sentences and save", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValueOnce(basic).mockResolvedValue({ ...basic, due_date: "2026-10-26", due_time: "18:00" });
    const { create, input, date, time } = setup();
    fireEvent.change(input, { target: { value: "后天晚上8点交作业" } });
    await waitFor(() => expect(date).toHaveValue("2026-10-23"));
    fireEvent.change(date, { target: { value: "2026-10-30" } });
    fireEvent.change(input, { target: { value: "下周一18:00交作业" } });
    await waitFor(() => expect(time).toHaveValue("18:00"));
    expect(date).toHaveValue("2026-10-30");
    fireEvent.change(time, { target: { value: "16:30" } });
    await userEvent.click(screen.getByRole("button", { name: "添加待办" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0]).toMatchObject({ due_date: "2026-10-30", due_time: "16:30", due_text: null, time_resolution: "overridden", timezone: "Europe/Berlin" });
  });

  it("does not freeze the date when only the time is manually changed", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValueOnce(basic).mockResolvedValue({ ...basic, due_date: "2026-10-26", due_time: "18:00" });
    const { input, date, time } = setup();
    fireEvent.change(input, { target: { value: "后天晚上8点交作业" } });
    await waitFor(() => expect(time).toHaveValue("20:00"));
    fireEvent.change(time, { target: { value: "16:30" } });
    fireEvent.change(input, { target: { value: "下周一18:00交作业" } });
    await waitFor(() => expect(date).toHaveValue("2026-10-26"));
    expect(time).toHaveValue("16:30");
  });

  it("a manual clear persists even if an in-flight parse contains a deadline", async () => {
    let finish!: (value: QuickParse) => void;
    const parse = vi.spyOn(api, "quickParse").mockResolvedValueOnce(basic).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { input, date, time } = setup();
    fireEvent.change(input, { target: { value: "后天交作业" } });
    await waitFor(() => expect(date).toHaveValue("2026-10-23"));
    fireEvent.change(input, { target: { value: "明天交作业" } });
    await waitFor(() => expect(parse).toHaveBeenCalledTimes(2));
    fireEvent.change(date, { target: { value: "2026-10-24" } });
    fireEvent.change(date, { target: { value: "" } });
    await act(async () => finish(basic));
    expect(date).toHaveValue(""); expect(time).toHaveValue("");
  });

  it("leaves uncertain dates blank and saves the original wording without a deadline", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValue(ambiguous);
    const { input, date, time, create } = setup();
    fireEvent.change(input, { target: { value: "大大后天交作业" } });
    expect(await screen.findByRole("button", { name: /可能是.*10月25日/ })).toBeVisible();
    expect(date).toHaveValue(""); expect(time).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "添加待办" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0]).toMatchObject({ title: "大大后天交作业", due_date: null, due_time: null });
  });

  it("records a candidate only after explicit confirmation and preserves that choice", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValue(ambiguous);
    const { input, date, create } = setup();
    fireEvent.change(input, { target: { value: "大大后天交作业" } });
    await userEvent.click(await screen.findByRole("button", { name: /可能是.*10月25日/ }));
    expect(date).toHaveValue("2026-10-25");
    await userEvent.click(screen.getByRole("button", { name: "添加待办" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0]).toMatchObject({ due_date: "2026-10-25", time_resolution: "confirmed" });
  });

  it("confirming a candidate date preserves a separately edited time", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValue(ambiguous);
    const { input, date, time, create } = setup();
    fireEvent.change(input, { target: { value: "大大后天交作业" } });
    await screen.findByRole("button", { name: /可能是.*10月25日/ });
    fireEvent.change(time, { target: { value: "18:30" } });
    await userEvent.click(screen.getByRole("button", { name: /可能是.*10月25日/ }));
    expect(date).toHaveValue("2026-10-25");
    expect(time).toHaveValue("18:30");
    await userEvent.click(screen.getByRole("button", { name: "添加待办" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0]).toMatchObject({ due_date: "2026-10-25", due_time: "18:30", time_resolution: "overridden" });
  });

  it("keeps exact times empty for dayparts and removes old automatic time after changing the sentence", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValueOnce(basic).mockResolvedValue({ ...basic, due_time: null, due_text: "明早" });
    const { input, date, time } = setup();
    fireEvent.change(input, { target: { value: "后天晚上8点交作业" } });
    await waitFor(() => expect(time).toHaveValue("20:00"));
    fireEvent.change(input, { target: { value: "明早交作业" } });
    await waitFor(() => expect(date).toHaveValue("2026-10-23"));
    expect(time).toHaveValue("");
  });

  it("shows time-only input without inventing a date and permits date-free creation on failure", async () => {
    vi.spyOn(api, "quickParse").mockResolvedValueOnce({ ...basic, due_date: null, due_time: null,
      temporal: { ...ambiguous.temporal!, status: "resolved", precision: "time", needs_confirmation: false, normalized_time: "20:00", explanation: ["date_required"], candidates: [] },
    }).mockRejectedValue(new Error("offline"));
    const { input, date, time, create } = setup();
    fireEvent.change(input, { target: { value: "20:00交作业" } });
    await waitFor(() => expect(time).toHaveValue("20:00"));
    expect(date).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "添加待办" }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0]).toMatchObject({ title: "20:00交作业", due_date: null, due_time: null });
  });
});
