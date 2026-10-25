import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import i18n from "@/i18n";
import { DEFAULT_APPEARANCE, setAppearance } from "@/lib/appearance";
import { AppearanceSection } from "./Appearance";

beforeEach(async () => { await i18n.changeLanguage("zh-CN"); setAppearance({ ...DEFAULT_APPEARANCE }); });

it("applies sliders and accent choices immediately and restores defaults", () => {
  render(<AppearanceSection />);
  fireEvent.change(screen.getByRole("slider", { name: /内容背景透明度/ }), { target: { value: "75" } });
  fireEvent.change(screen.getByRole("slider", { name: /背景图片模糊/ }), { target: { value: "15" } });
  fireEvent.click(screen.getByRole("button", { name: "主题颜色 #2563eb" }));
  expect(document.documentElement.style.getPropertyValue("--appearance-opacity")).toBe("0.25");
  expect(document.documentElement.style.getPropertyValue("--appearance-blur")).toBe("15px");
  expect(document.documentElement.style.getPropertyValue("--appearance-color")).toBe("#2563eb");
  fireEvent.click(screen.getByRole("button", { name: "恢复默认外观" }));
  expect(screen.getByRole("slider", { name: /背景图片模糊/ })).toHaveValue("0");
  expect(document.documentElement.dataset.customColor).toBe("false");
});
