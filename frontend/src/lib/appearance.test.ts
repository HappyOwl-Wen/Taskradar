import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, MAX_BACKGROUND_BYTES, normalizeAppearance, setAppearance, setBackgroundImage } from "./appearance";
import { imageStorage } from "./appearanceImages";

vi.mock("./appearanceImages", () => ({ imageStorage: vi.fn() }));
vi.mock("./imagePalette", async (importOriginal) => ({ ...await importOriginal<typeof import("./imagePalette")>(), extractImageColor: vi.fn().mockResolvedValue("#197a65") }));
let urlCounter = 0;
vi.stubGlobal("URL", class extends URL {
  static createObjectURL = vi.fn(() => `blob:http://localhost/background-${++urlCounter}`);
  static revokeObjectURL = vi.fn();
});
afterAll(() => vi.unstubAllGlobals());

describe("appearance preferences", () => {
  beforeEach(() => { localStorage.clear(); setAppearance({ ...DEFAULT_APPEARANCE }); });
  it("persists preferences and applies them again after reload", async () => {
    setAppearance({ background: "solid", blur: 12, transparency: 65, color: "#2563eb" });
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toMatchObject({ blur: 12, transparency: 65 });
    document.documentElement.style.removeProperty("--appearance-blur");
    vi.resetModules();
    await import("./appearance");
    expect(document.documentElement.style.getPropertyValue("--appearance-blur")).toBe("12px");
    expect(document.documentElement.dataset.background).toBe("solid");
  });
  it("rejects external image URLs and invalid values from storage", () => {
    expect(normalizeAppearance({ image: "https://example.com/image.jpg", color: "red", blur: Infinity, transparency: -50 }))
      .toMatchObject({ image: "", color: DEFAULT_APPEARANCE.color, blur: 0, transparency: 0 });
    setAppearance({ background: "image", image: "" });
    expect(document.documentElement.dataset.background).toBe("landscape");
  });
  it("keeps the previous appearance when storage is full", () => {
    const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    try {
      expect(() => setAppearance({ blur: 20 })).toThrow("quota");
      expect(document.documentElement.style.getPropertyValue("--appearance-blur")).toBe("0px");
    } finally { save.mockRestore(); }
  });
  it("stores an 8 MB image separately and restores it without filling localStorage", async () => {
    const image = "data:image/png;base64," + "A".repeat(Math.ceil(MAX_BACKGROUND_BYTES / 3) * 4);
    vi.mocked(imageStorage).mockResolvedValue(image);
    await setBackgroundImage(image);
    const stored = localStorage.getItem(APPEARANCE_KEY)!;
    expect(stored.length).toBeLessThan(400);
    expect(JSON.parse(stored)).toMatchObject({ image: "", background: "image", imageKey: expect.any(String) });
    vi.resetModules();
    await import("./appearance");
    expect(document.documentElement.dataset.background).toBe("image");
    expect(document.documentElement.style.getPropertyValue("--appearance-image")).toMatch(/^url\("blob:/);
    expect(document.documentElement.style.getPropertyValue("--appearance-image").length).toBeLessThan(100);
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  });
  it("reuses the Blob URL for color edits and releases it on image removal", async () => {
    vi.mocked(imageStorage).mockResolvedValue(undefined);
    await setBackgroundImage("data:image/png;base64,AAAA");
    const url = document.documentElement.style.getPropertyValue("--appearance-image");
    const count = vi.mocked(URL.createObjectURL).mock.calls.length;
    setAppearance({ color: "#2563eb", blur: 12 });
    expect(document.documentElement.style.getPropertyValue("--appearance-image")).toBe(url);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(count);
    setAppearance({ image: "", background: "landscape" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url.slice(5, -2));
    expect(document.documentElement.style.getPropertyValue("--appearance-image")).toBe("none");
  });
  it("does not replace the image preference when IndexedDB fails", async () => {
    vi.mocked(imageStorage).mockRejectedValueOnce(new Error("quota"));
    await expect(setBackgroundImage("data:image/png;base64,AAAA")).rejects.toThrow("quota");
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toMatchObject({ background: "landscape", image: "" });
  });
  it("matches uploaded images automatically but preserves a manual accent until matching is enabled", async () => {
    vi.mocked(imageStorage).mockResolvedValue(undefined);
    await setBackgroundImage("data:image/png;base64,AAAA");
    expect(document.documentElement.style.getPropertyValue("--appearance-color")).toBe("#197a65");
    expect(document.documentElement.dataset.imageContrast).toBe("true");
    setAppearance({ color: "#2563eb" });
    await setBackgroundImage("data:image/png;base64,AAAA");
    expect(document.documentElement.style.getPropertyValue("--appearance-color")).toBe("#2563eb");
    setAppearance({ autoColor: true });
    expect(document.documentElement.style.getPropertyValue("--appearance-color")).toBe("#197a65");
    setAppearance({ background: "solid" });
    expect(document.documentElement.dataset.imageContrast).toBe("false");
  });
});
