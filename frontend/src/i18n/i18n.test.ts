import { describe, expect, it } from "vitest";
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
