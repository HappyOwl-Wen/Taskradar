// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { build, type Plugin } from "vite";
import { publishIndexLast } from "./publishIndexLast";

let fixture = "";
afterEach(async () => {
  if (!fixture) return;
  // Only remove this test's generated directory, never a workspace or configured production output.
  if (dirname(resolve(fixture)) !== resolve(tmpdir()) || !basename(fixture).startsWith("taskradar-assets-")) throw new Error("Unexpected fixture path");
  await rm(fixture, { recursive: true, force: true });
  fixture = "";
});

async function prepare() {
  fixture = await mkdtemp(join(tmpdir(), "taskradar-assets-"));
  await writeFile(join(fixture, "index.html"), '<div id="root"></div><script type="module" src="/entry.js"></script>');
  await writeFile(join(fixture, "entry.js"), 'import "./style.css"; document.addEventListener("click", () => import("./page.js").then(m => document.body.textContent = m.default));');
  await version("A");
}

async function version(value: string) {
  await writeFile(join(fixture, "page.js"), `export default ${JSON.stringify(value)};`);
  await writeFile(join(fixture, "style.css"), `body { color: ${value === "A" ? "blue" : "green"}; }`);
}

function compile(extra: Plugin[] = []) {
  return build({ configFile: false, root: fixture, logLevel: "silent", plugins: [publishIndexLast(), ...extra], build: { outDir: "site", emptyOutDir: false, minify: false } });
}

it("keeps old lazy scripts and CSS available, and replaces HTML only after the new assets are written", async () => {
  await prepare();
  await compile();
  const site = join(fixture, "site"), assets = join(site, "assets");
  const previousHtml = await readFile(join(site, "index.html"), "utf8");
  const previousAssets = new Map(await Promise.all((await readdir(assets)).map(async name => [name, await readFile(join(assets, name), "utf8")] as const)));
  expect([...previousAssets.keys()].some(name => /^page-.*\.js$/.test(name))).toBe(true);
  expect([...previousAssets.keys()].some(name => name.endsWith(".css"))).toBe(true);
  await version("B");
  let inspectedBeforePublish = false;
  await compile([{
    name: "verify-assets-before-html",
    writeBundle: { order: "pre", async handler() {
      expect(await readFile(join(site, "index.html"), "utf8")).toBe(previousHtml);
      expect((await readdir(assets)).length).toBeGreaterThan(previousAssets.size);
      inspectedBeforePublish = true;
    } },
  }]);
  expect(inspectedBeforePublish).toBe(true);
  expect(await readFile(join(site, "index.html"), "utf8")).not.toBe(previousHtml);
  for (const [name, contents] of previousAssets) expect(await readFile(join(assets, name), "utf8")).toBe(contents);
});

it("leaves the previous working entry untouched if generating a new build fails", async () => {
  await prepare();
  await compile();
  const entry = join(fixture, "site/index.html");
  const previousHtml = await readFile(entry, "utf8");
  await version("B");
  await expect(compile([{ name: "failed-build", generateBundle() { throw new Error("simulated build failure"); } }])).rejects.toThrow("simulated build failure");
  expect(await readFile(entry, "utf8")).toBe(previousHtml);
});
