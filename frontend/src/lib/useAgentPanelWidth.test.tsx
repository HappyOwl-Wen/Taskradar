import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentPanelWidth } from "./useAgentPanelWidth";

function Panel({ wide = true }: { wide?: boolean }) {
  const panel = useAgentPanelWidth(wide);
  return <div role="separator" aria-valuenow={panel.width} aria-valuemin={panel.minimum} aria-valuemax={panel.maximum} {...panel.handle} />;
}
beforeEach(() => { localStorage.clear(); vi.stubGlobal("innerWidth", 1440); });
afterEach(() => vi.unstubAllGlobals());

it("supports keyboard bounds, reset and persisted width", () => {
  const first = render(<Panel />);
  const handle = screen.getByRole("separator");
  expect(handle).toHaveAttribute("aria-valuenow", "420");
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(handle).toHaveAttribute("aria-valuenow", "444");
  first.unmount();
  render(<Panel />);
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "444");
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "800");
  fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" });
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "320");
  fireEvent.doubleClick(screen.getByRole("separator"));
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "420");
});

it("drags with pointer capture and stops after release", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  render(<Panel />);
  const handle = screen.getByRole("separator");
  handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = () => true; handle.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { button: 0, clientX: 1000 });
  expect(handle.setPointerCapture).toHaveBeenCalled();
  fireEvent.pointerMove(handle, { clientX: 900 });
  expect(handle).toHaveAttribute("aria-valuenow", "520");
  fireEvent.pointerMove(handle, { clientX: 0 });
  expect(handle).toHaveAttribute("aria-valuenow", "800");
  fireEvent.pointerUp(handle);
  fireEvent.pointerMove(handle, { clientX: 1200 });
  expect(handle).toHaveAttribute("aria-valuenow", "800");
  expect(handle.releasePointerCapture).toHaveBeenCalled();
});

it("fits a small viewport without losing the desktop preference", () => {
  localStorage.setItem("taskradar.agent.width", "700");
  const view = render(<Panel />);
  vi.stubGlobal("innerWidth", 390);
  view.rerender(<Panel wide={false} />);
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "390");
  expect(localStorage.getItem("taskradar.agent.width")).toBe("700");
  vi.stubGlobal("innerWidth", 1440);
  view.rerender(<Panel />);
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "700");
});
