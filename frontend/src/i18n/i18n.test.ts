import { beforeAll, describe, expect, it } from "vitest";
import i18n, { describeCode } from "./index";
import en from "./en";
import zhCN from "./zh-CN";

type Tree = { readonly [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else flatten(value, path).forEach((v, k) => out.set(k, v));
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  const zh = flatten(zhCN as unknown as Tree);
  const english = flatten(en as unknown as Tree);

  it("have the same keys in every language", () => {
    expect([...english.keys()].sort()).toEqual([...zh.keys()].sort());
  });

  it("use the same interpolation variables", () => {
    for (const [key, text] of zh) {
      expect(placeholders(english.get(key) ?? ""), key).toEqual(placeholders(text));
    }
  });

  it("have no empty strings", () => {
    for (const [key, text] of [...zh, ...english]) expect(text.trim(), key).not.toBe("");
  });
});

describe("describeCode", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("translates parametrised backend codes", () => {
    expect(describeCode("page_2_ocr_failed")).toBe("OCR failed on page 2");
    expect(describeCode("duplicate_content_of:12")).toBe("Same content as file #12");
    expect(describeCode("sent_or_draft")).toBe("Sent mail or draft, not analysed");
  });

  it("falls back to the raw code for unknown values", () => {
    expect(describeCode("something_new")).toBe("something_new");
  });
});
