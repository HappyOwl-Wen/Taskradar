// The main flow in the real TaskRadar window, driven like a user with the mouse (Chinese interface):
// start -> add content (files through the Windows file chooser) -> confirm what was found -> look at the tasks ->
// tick one off and find it under "已完成". Prints each step with its time and saves screenshots of the page and of
// the whole window with its title bar. Fails (exit code 1) when a step does not happen or the page reports errors.
//
// Start TaskRadar first with an empty scratch data folder and the WebView2 debugging port (tests only), e.g.:
//   $env:TASKRADAR_WEBVIEW_DEBUG_PORT = "9222"
//   dist\TaskRadar\TaskRadar.exe --data-dir "$env:TEMP\taskradar-check"
// then, from the repository folder:
//   node scripts/desktop-check/flow.mjs 9222 build/desktop-check backend/src/taskradar/demo/samples/06_en_rental_contract.pdf
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp.mjs";

const [port, outArg, ...fileArgs] = process.argv.slice(2);
if (!port || !outArg || fileArgs.length === 0) {
  console.error("usage: node flow.mjs <debugPort> <outDir> <file> [file...]");
  process.exit(2);
}
const outDir = resolve(outArg);
const files = fileArgs.map((f) => resolve(f));
mkdirSync(outDir, { recursive: true });
const WINDOW = fileURLToPath(new URL("./window.py", import.meta.url));
const PYTHON = process.env.PYTHON ?? fileURLToPath(new URL("../../backend/.venv/Scripts/python.exe", import.meta.url));
const hwnd = () => execFileSync(PYTHON, [WINDOW, "find"]).toString().trim().split(/\s+/)[1];
const windowShot = (name) => execFileSync(PYTHON, [WINDOW, "shot", hwnd(), `${outDir}/${name}`]);

const t0 = Date.now();
const c = await connect(port, "127.0.0.1:");
await c.send("Page.enable");
await c.send("Runtime.enable");
await c.send("DOM.enable");
const errors = [];
c.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
c.on("Runtime.consoleAPICalled", (p) => p.type === "error" && errors.push(p.args.map((a) => a.value ?? a.description).join(" ")));
const step = (n, text, extra = "") => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${n}. ${text}${extra ? ` - ${extra}` : ""}`);
const openRows = `document.querySelectorAll('[role=checkbox][aria-label^="把「"]')`;

// 1. Start
await c.waitFor(`document.querySelector("main h1")?.textContent`, 20000, "first page");
step(1, "started", await c.evaluate(`document.querySelector("main h1").textContent`));
await sleep(400);
await c.shot(`${outDir}/01-start.png`);
windowShot("01-start-window.png");

// 2. Add content: the sidebar entry, then the page's main button and the Windows file chooser
await c.click("nav a", "添加内容");
await c.waitFor(`location.pathname === "/sources"`);
await sleep(300);
await c.shot(`${outDir}/02-add-content.png`);
await c.send("Page.setInterceptFileChooserDialog", { enabled: true });
const chooser = new Promise((done) => c.on("Page.fileChooserOpened", done));
await c.click("main button", "导入文件");
const opened = await chooser;
await c.send("DOM.setFileInputFiles", { files, backendNodeId: opened.backendNodeId });
await c.send("Page.setInterceptFileChooserDialog", { enabled: false });
step(2, "files chosen", files.map((f) => f.split(/[\\/]/).pop()).join(", "));
await c.waitFor(`[...document.querySelectorAll("a")].some((a) => a.textContent.includes("去确认") && a.offsetParent)`, 60000, "import result");
step(2, "imported", (await c.evaluate(`document.querySelector("#last-import-title")?.parentElement?.innerText ?? ""`)).replace(/\s+/g, " "));
await sleep(300);
await c.shot(`${outDir}/03-imported.png`);

// 3. Confirm what was found, one task after the other
await c.click("a", "去确认");
await c.waitFor(`location.pathname === "/inbox"`);
await c.waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.includes("确认任务"))`, 10000, "decision bar");
await sleep(400);
const waiting = await c.evaluate(`document.querySelectorAll('ul[aria-label] > li:not([role=presentation])').length`);
step(3, "review queue open", `${waiting} item(s)`);
await c.shot(`${outDir}/04-review.png`);
windowShot("04-review-window.png");
for (let i = 0; i < 20; i++) {
  const ready = await c.evaluate(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "确认任务" && !b.disabled && b.offsetParent)`);
  if (!ready) break;
  const title = await c.evaluate(`document.querySelector("main h2")?.textContent.trim() ?? ""`);
  await c.click("button", "确认任务");
  const toast = JSON.stringify(`已确认「${title}」`);
  await c.waitFor(`[...document.querySelectorAll("[data-sonner-toast]")].some((t) => t.textContent.includes(${toast}))`, 10000, `confirmation of ${title}`);
  step(3, `confirmed #${i + 1}`, title);
  await sleep(700);
}
await sleep(500);
await c.shot(`${outDir}/05-all-confirmed.png`);

// 4. Look at the tasks
await c.click("nav a", "我的任务");
await c.waitFor(`location.pathname === "/tasks"`);
await c.waitFor(`${openRows}.length > 0`, 10000, "task rows");
const rows = await c.evaluate(`[...document.querySelectorAll('main ul > li a')].map((a) => a.textContent.trim())`);
step(4, "task list", JSON.stringify(rows));
await sleep(300);
await c.shot(`${outDir}/06-tasks.png`);
windowShot("06-tasks-window.png");
const target = rows[0];
await c.click("main ul > li a", target);
await c.waitFor(`location.pathname.startsWith("/tasks/")`);
await sleep(500);
step(4, "task opened", await c.evaluate(`document.querySelector("main h1")?.textContent`));
await c.shot(`${outDir}/07-task-detail.png`);
await c.click("main a, main button", "返回");
await c.waitFor(`location.pathname === "/tasks"`);
await c.waitFor(`${openRows}.length > 0`);

// 5. Tick it off in the list: the row folds away and "撤销" (undo) is offered; then it is listed as completed
const label = `把「${target}」标记为已完成`;
await c.click(`[aria-label=${JSON.stringify(label)}]`);
await c.waitFor(`[...document.querySelectorAll("[data-sonner-toast]")].some((t) => t.textContent.includes("撤销"))`, 10000, "undo toast");
await c.waitFor(`!document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`, 10000, "row gone from the open tasks");
step(5, "ticked off", target);
await sleep(300);
await c.shot(`${outDir}/08-completed.png`);
windowShot("08-completed-window.png");
await c.click("button[role=tab]", "已完成");
await c.waitFor(`[...document.querySelectorAll('main ul > li a')].some((a) => a.textContent.includes(${JSON.stringify(target)}))`, 10000, "in the completed tab");
step(5, "listed under 已完成", target);
await sleep(300);
await c.shot(`${outDir}/09-completed-tab.png`);

console.log(errors.length ? `PAGE ERRORS:\n${errors.join("\n")}` : "no page errors");
c.close();
process.exit(errors.length ? 1 : 0);
