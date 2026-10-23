import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFoldAway } from "./foldAway";

const items = (...ids: string[]) => ids.map((id) => ({ id }));

describe("useFoldAway", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps adjacent disappearing rows at their previous anchors until the animation ends", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ rows }) => useFoldAway(rows, "open"), {
      initialProps: { rows: items("a", "b", "c", "d", "e", "f") },
    });
    rerender({ rows: items("c", "f") });
    expect(result.current.map(({ item, leaving }) => [item.id, leaving])).toEqual([
      ["a", true], ["b", true], ["c", false], ["d", true], ["e", true], ["f", false],
    ]);
    act(() => vi.advanceTimersByTime(260));
    expect(result.current.map(({ item }) => item.id)).toEqual(["c", "f"]);
  });

  it("keeps previous ghosts in order when their anchor also disappears", () => {
    const { result, rerender } = renderHook(({ rows }) => useFoldAway(rows, "open"), {
      initialProps: { rows: items("a", "b", "c", "d") },
    });
    rerender({ rows: items("a", "c", "d") });
    rerender({ rows: items("c", "d") });
    expect(result.current.map(({ item, leaving }) => [item.id, leaving])).toEqual([
      ["a", true], ["c", false], ["d", false], ["b", true],
    ]);
    rerender({ rows: items("a", "c", "d") });
    expect(result.current.map(({ item, leaving }) => [item.id, leaving])).toEqual([
      ["a", false], ["b", true], ["c", false], ["d", false],
    ]);
  });

  it("clears animations on a scope change and skips a mass removal", () => {
    const { result, rerender } = renderHook(({ rows, scope }) => useFoldAway(rows, scope, 2), {
      initialProps: { rows: items("a", "b", "c", "d"), scope: "open" },
    });
    rerender({ rows: items("a", "c", "d"), scope: "open" });
    rerender({ rows: items("a", "c", "d"), scope: "all" });
    expect(result.current.every((row) => !row.leaving)).toBe(true);
    rerender({ rows: [], scope: "all" });
    expect(result.current).toEqual([]);
  });

  it("reads row identities a linear number of times when many removals animate", () => {
    let reads = 0;
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      get id() { reads++; return String(index); },
    }));
    const { result, rerender } = renderHook(({ rows }) => useFoldAway(rows, "open", 1000), {
      initialProps: { rows },
    });
    reads = 0;
    rerender({ rows: rows.filter((_, index) => index % 2 === 0) });
    expect(result.current).toHaveLength(1000);
    expect(reads).toBeLessThan(15 * rows.length);
  });
});
