import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepToastsClear } from "./toastClearance";

const clearance = () => document.documentElement.style.getPropertyValue("--toast-clearance");

function bar(height: number) {
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetHeight", { value: height });
  return el;
}

describe("keepToastsClear", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.style.removeProperty("--toast-clearance");
  });

  it("publishes the bar's height while it is shown and takes it back after it has gone", () => {
    const cleanup = keepToastsClear(bar(69));
    expect(clearance()).toBe("69px");
    cleanup?.();
    expect(clearance()).toBe("69px"); // kept for a moment: the next task's bar usually follows
    vi.advanceTimersByTime(1000);
    expect(clearance()).toBe("");
    expect(keepToastsClear(null)).toBeUndefined();
  });

  it("is not taken back while the next bar has taken over", () => {
    const first = keepToastsClear(bar(69));
    first?.();
    const second = keepToastsClear(bar(121));
    vi.advanceTimersByTime(1000);
    expect(clearance()).toBe("121px");
    second?.();
    vi.advanceTimersByTime(1000);
    expect(clearance()).toBe("");
  });
});
