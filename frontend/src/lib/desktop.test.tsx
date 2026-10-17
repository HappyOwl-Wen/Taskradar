import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { api } from "./api";
import { hasUnsavedChanges, setDesktopApp, useUnsavedChanges } from "./desktop";
import { useFoldAway } from "./foldAway";

describe("desktop window: unsaved changes", () => {
  afterEach(() => {
    setDesktopApp(false);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("tells the window while a form holds unsaved input, once per change", async () => {
    vi.useFakeTimers();
    const report = vi.spyOn(api, "updateDesktopState").mockResolvedValue({ ok: true });
    setDesktopApp(true);
    const { rerender, unmount } = renderHook(({ dirty }) => useUnsavedChanges(dirty), { initialProps: { dirty: false } });
    await act(async () => void vi.advanceTimersByTime(200));
    expect(report).toHaveBeenLastCalledWith({ unsaved: false });

    rerender({ dirty: true });
    expect(hasUnsavedChanges()).toBe(true);
    await act(async () => void vi.advanceTimersByTime(200));
    expect(report).toHaveBeenLastCalledWith({ unsaved: true });

    const calls = report.mock.calls.length;
    rerender({ dirty: true });
    await act(async () => void vi.advanceTimersByTime(200));
    expect(report.mock.calls.length).toBe(calls); // nothing changed, nothing sent

    unmount(); // the dialog closed
    expect(hasUnsavedChanges()).toBe(false);
    await act(async () => void vi.advanceTimersByTime(200));
    expect(report).toHaveBeenLastCalledWith({ unsaved: false });
  });

  it("does not report anything in a browser tab", async () => {
    vi.useFakeTimers();
    const report = vi.spyOn(api, "updateDesktopState").mockResolvedValue({ ok: true });
    const { unmount } = renderHook(() => useUnsavedChanges(true));
    await act(async () => void vi.advanceTimersByTime(200));
    expect(report).not.toHaveBeenCalled();
    expect(hasUnsavedChanges()).toBe(true);
    unmount();
  });
});

describe("rows that leave a list fold away", () => {
  afterEach(() => vi.useRealTimers());

  const a = { id: "a" };
  const b = { id: "b" };
  const c = { id: "c" };

  it("keeps a ticked-off row in its place for a moment, then drops it", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ items, scope }) => useFoldAway(items, scope), {
      initialProps: { items: [a, b, c], scope: "open" },
    });
    rerender({ items: [a, c], scope: "open" });
    expect(result.current.map((r) => [r.item.id, r.leaving])).toEqual([
      ["a", false],
      ["b", true],
      ["c", false],
    ]);
    act(() => void vi.advanceTimersByTime(300));
    expect(result.current.map((r) => r.item.id)).toEqual(["a", "c"]);
  });

  it("shows another view or filter at once", () => {
    const { result, rerender } = renderHook(({ items, scope }) => useFoldAway(items, scope), {
      initialProps: { items: [a, b, c], scope: "open" },
    });
    rerender({ items: [c], scope: "done" });
    expect(result.current).toEqual([{ item: c, leaving: false }]);
  });

  it("does not animate many rows leaving at once (a list that was replaced)", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: String(i) }));
    const { result, rerender } = renderHook(({ items }) => useFoldAway(items, "open"), { initialProps: { items: many } });
    rerender({ items: [many[0]] });
    expect(result.current.every((r) => !r.leaving)).toBe(true);
  });
});

describe("buttons while their action runs", () => {
  it("keep their size and name, take no clicks and say they are busy", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button loading={false} onClick={onClick}>
        保存
      </Button>,
    );
    const button = screen.getByRole("button", { name: "保存" });
    expect(button).not.toBeDisabled();
    rerender(
      <Button loading onClick={onClick}>
        保存
      </Button>,
    );
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "保存" })).toBe(button);
  });
});
