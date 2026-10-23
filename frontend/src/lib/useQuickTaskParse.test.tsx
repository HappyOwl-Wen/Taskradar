import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import type { QuickParse } from "./types";
import { useQuickTaskParse } from "./useQuickTaskParse";

const parsed = (date: string): QuickParse => ({
  title: "交作业", category: "academic", action_type: "submit", due_date: date, due_time: null,
  due_text: "明天", time_semantics: "deadline", ambiguous: false, alternatives: [],
});
const deferred = () => {
  let resolve!: (value: QuickParse) => void;
  const promise = new Promise<QuickParse>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("quick entry request lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("debounces a burst, ignores whitespace-only changes and waits for IME composition", async () => {
    const request = vi.spyOn(api, "quickParse").mockResolvedValue(parsed("2026-10-22"));
    const { result } = renderHook(useQuickTaskParse);
    act(() => {
      result.current.onText("明"); result.current.onText("明天"); result.current.onText("明天交作业");
    });
    await act(() => vi.advanceTimersByTimeAsync(249));
    expect(request).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(request).toHaveBeenCalledTimes(1);
    act(() => result.current.onText(" 明天交作业 "));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(request).toHaveBeenCalledTimes(1);
    act(() => { result.current.onCompositionStart(); result.current.onText("后天交作业"); });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(request).toHaveBeenCalledTimes(1);
    act(() => result.current.onCompositionEnd());
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("invalidates requests immediately on input, even during the next debounce and A-B-A edits", async () => {
    const first = deferred(); const second = deferred();
    vi.spyOn(api, "quickParse").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(useQuickTaskParse);
    act(() => result.current.onText("明天交作业"));
    await act(() => vi.advanceTimersByTimeAsync(250));
    act(() => { result.current.onText("后天交作业"); result.current.onText("明天交作业"); });
    await act(async () => first.resolve(parsed("2026-10-22")));
    expect(result.current.result).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(250));
    await act(async () => second.resolve(parsed("2026-10-23")));
    expect(result.current.result?.due_date).toBe("2026-10-23");
  });

  it("keeps the newest response when requests finish in reverse order", async () => {
    const old = deferred(); const recent = deferred();
    vi.spyOn(api, "quickParse").mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
    const { result } = renderHook(useQuickTaskParse);
    act(() => result.current.onText("明天"));
    await act(() => vi.advanceTimersByTimeAsync(250));
    act(() => result.current.onText("后天"));
    await act(() => vi.advanceTimersByTimeAsync(250));
    await act(async () => recent.resolve(parsed("2026-10-23")));
    await act(async () => old.resolve(parsed("2026-10-22")));
    expect(result.current.result?.due_date).toBe("2026-10-23");
  });

  it("shares a pending request with submit, cancels the debounce and refreshes completed results", async () => {
    const pending = deferred();
    const request = vi.spyOn(api, "quickParse").mockReturnValueOnce(pending.promise).mockResolvedValue(parsed("2026-10-23"));
    const { result } = renderHook(useQuickTaskParse);
    act(() => result.current.onText("明天"));
    let saving!: Promise<QuickParse | null>;
    act(() => { saving = result.current.flush(); });
    expect(result.current.flush()).toBe(saving);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(parsed("2026-10-22")); await saving; });
    await act(async () => { await result.current.flush(); });
    expect(result.current.result?.due_date).toBe("2026-10-23");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("permits date-free saving when parsing fails or stalls and ignores a late timeout response", async () => {
    const pending = deferred();
    const request = vi.spyOn(api, "quickParse").mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(useQuickTaskParse);
    act(() => result.current.onText("明天"));
    await act(() => vi.advanceTimersByTimeAsync(4250));
    expect(result.current.result).toBeNull();
    expect(result.current.unavailable).toBe(true);
    await act(async () => pending.resolve(parsed("2026-10-22")));
    expect(result.current.result).toBeNull();
    await act(async () => { expect(await result.current.flush()).toBeNull(); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("clearing or unmounting never restores a pending result", async () => {
    const pending = deferred();
    const request = vi.spyOn(api, "quickParse").mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(useQuickTaskParse);
    act(() => result.current.onText("明天"));
    await act(() => vi.advanceTimersByTimeAsync(250));
    act(() => result.current.onText(""));
    await act(async () => pending.resolve(parsed("2026-10-22")));
    expect(result.current.result).toBeNull();
    act(() => result.current.onText("后天"));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(request).toHaveBeenCalledTimes(1);
  });
});
