import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button } from "./button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger, Tip, TooltipProvider } from "./menu";
import { SimpleSelect } from "./select";
import { PopupTriggerEffects } from "./PopupTriggerEffects";

const methods = ["scrollIntoView", "hasPointerCapture", "releasePointerCapture", "setPointerCapture"] as const;
const originals = methods.map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(32);
  // jsdom supplies no layout or native pointer capture/scrolling; keep the real Radix controls and portals.
  for (const name of methods) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: name === "hasPointerCapture" ? () => false : vi.fn() });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [name, original] of originals) {
    if (original) Object.defineProperty(HTMLElement.prototype, name, original);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

it("launches the real menu through a tooltip-wrapped button, restores focus on Escape, and restarts without duplicate lenses", async () => {
  const user = userEvent.setup();
  render(<TooltipProvider><PopupTriggerEffects /><DropdownMenu>
    <Tip content="Appearance"><DropdownMenuTrigger asChild><Button>More</Button></DropdownMenuTrigger></Tip>
    <DropdownMenuContent><DropdownMenuItem>Theme</DropdownMenuItem></DropdownMenuContent>
  </DropdownMenu></TooltipProvider>);
  const button = screen.getByRole("button", { name: "More" });
  expect(button).toHaveAttribute("data-trigger-motion", "idle");
  await user.click(button);
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(button).toHaveAttribute("data-trigger-motion", "launch"));
  expect(button).toHaveAttribute("aria-controls", menu.id);
  expect(button.querySelectorAll(".popup-trigger-glass")).toHaveLength(1);
  expect(button.querySelector(".popup-trigger-glass")).toHaveAttribute("aria-hidden", "true");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(button).toHaveAttribute("data-trigger-motion", "return"));
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  await waitFor(() => expect(button).toHaveAttribute("data-trigger-motion", "launch"));
  expect(button.querySelectorAll(".popup-trigger-glass")).toHaveLength(1);
  expect(button).toHaveAccessibleName("More");
});

it("follows a flipped popover, survives a text-only label update, and removes only its decorative layer on cleanup", async () => {
  const user = userEvent.setup();
  function Example({ label, effects = true }: { label: string; effects?: boolean }) {
    return <>{effects && <PopupTriggerEffects />}<Popover>
      <PopoverTrigger asChild><Button>{label}</Button></PopoverTrigger>
      <PopoverContent aria-label="Details">Popover body</PopoverContent>
    </Popover></>;
  }
  const { rerender } = render(<Example label="Inspect" />);
  const button = screen.getByRole("button", { name: "Inspect" });
  await user.click(button);
  const panel = await screen.findByRole("dialog", { name: "Details" });
  await act(async () => { panel.dataset.side = "top"; });
  await waitFor(() => expect(button).toHaveAttribute("data-trigger-side", "top"));
  expect(button.style.getPropertyValue("--trigger-y")).toBe("-4px");
  rerender(<Example label="Inspect updated" />);
  await waitFor(() => expect(button.querySelectorAll(".popup-trigger-glass")).toHaveLength(1));
  expect(button).toHaveAccessibleName("Inspect updated");
  rerender(<Example label="Inspect updated" effects={false} />);
  expect(button.querySelector(".popup-trigger-glass")).toBeNull();
  expect(button).not.toHaveAttribute("data-trigger-motion");
  expect(button).not.toHaveAttribute("data-trigger-ready");
  expect(button.style.getPropertyValue("--trigger-y")).toBe("");
  expect(screen.getByRole("dialog", { name: "Details" })).toHaveTextContent("Popover body");
});

it("hands off a keyboard-opened select and preserves normal value selection", async () => {
  const user = userEvent.setup(), onChange = vi.fn();
  render(<><PopupTriggerEffects /><SimpleSelect value="a" onValueChange={onChange} ariaLabel="Task" options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} /></>);
  const button = screen.getByRole("combobox", { name: "Task" });
  expect(button).toHaveAttribute("data-trigger-ready", "true");
  expect(button.style.getPropertyValue("--trigger-border")).toBe("var(--input)");
  expect(button.style.getPropertyValue("--trigger-rest-opacity")).toBe("1");
  button.focus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("listbox");
  await waitFor(() => expect(button).toHaveAttribute("data-trigger-motion", "launch"));
  await user.keyboard("b{Enter}");
  await waitFor(() => expect(onChange).toHaveBeenCalledWith("b"));
  await waitFor(() => expect(button).toHaveAttribute("data-trigger-motion", "return"));
  expect(button).toHaveFocus();
});
