import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { nativeMath } from "@/lib/agentMarkdown";
import { AgentMarkdown } from "./AgentMarkdown";

it("renders headings, GFM tables, task lists, links and literal code", () => {
  const { container } = render(<AgentMarkdown>{"## Plan\n\n**Focus** and ~~noise~~\n\n- [x] Draft\n\n| Task | Time |\n| --- | --- |\n| Report | 10:00 |\n\n```js\nconst x = 1;\n```\n\n[Docs](https://example.test/docs)"}</AgentMarkdown>);
  expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
  expect(screen.getByRole("table")).toHaveTextContent("Report");
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(container.querySelector("pre code")).toHaveTextContent("const x = 1;");
  expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("rel", "noopener noreferrer");
});

it("keeps raw HTML and unsafe URLs inert and does not automatically fetch images", () => {
  const { container } = render(<AgentMarkdown>{'<script>alert(1)</script>\n\n<img src="https://tracker.test/raw">\n\n[Unsafe](javascript:alert(1))\n\n![Diagram](https://tracker.test/image.png)'}</AgentMarkdown>);
  expect(container.querySelector("script, img")).toBeNull();
  expect(screen.queryByRole("link", { name: "Unsafe" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Diagram" })).toHaveAttribute("href", "https://tracker.test/image.png");
});

it("renders native inline/display math and preserves code and currency text", () => {
  const code = "``\\(code\\)``\n\n```text\n\\[literal\\]\n```";
  expect(nativeMath(code)).toBe(code);
  const { container } = render(<AgentMarkdown>{"Inline \\(x^2\\), price $20.\n\n\\[a+b=c\\]\n\n" + code}</AgentMarkdown>);
  expect(container.querySelectorAll(".katex")).toHaveLength(2);
  expect(container.querySelector(".katex-display")).toBeInTheDocument();
  expect(container).toHaveTextContent("price $20");
  expect(container.querySelector("pre code")).toHaveTextContent("\\[literal\\]");
});
