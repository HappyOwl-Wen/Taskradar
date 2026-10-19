// The main flow in the real TaskRadar window, driven like a user with the mouse and keyboard (Chinese interface):
// start -> add two to-dos with one sentence each -> start one (it moves to "进行中") -> delete the other -> tick the
// first off and find it under "已完成" -> run the Pomodoro timer (the sidebar shows its time) -> a 5-second countdown
// that ends with a notification -> the guide in the settings. Prints each step with its time and saves screenshots
// of the page and of the whole window with its title bar. Fails (exit code 1) when a step does not happen or the page
// reports errors.
//
// Start TaskRadar first with an empty scratch data folder and the WebView2 debugging port (tests only), e.g.:
//   $env:TASKRADAR_WEBVIEW_DEBUG_PORT = "9222"
//   dist\TaskRadar\TaskRadar.exe --data-dir "$env:TEMP\taskradar-check"
// then, from the repository folder:
//   node scripts/desktop-check/flow.mjs 9222 build/desktop-check
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp.mjs";

const [port, outArg] = process.argv.slice(2);
if (!port || !outArg) {
  console.error("usage: node flow.mjs <debugPort> <outDir>");
  process.exit(2);
}
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });
const WINDOW = fileURLToPath(new URL("./window.py", import.meta.url));
const PYTHON = process.env.PYTHON ?? fileURLToPath(new URL("../../backend/.venv/Scripts/python.exe", import.meta.url));
const hwnd = () => execFileSync(PYTHON, [WINDOW, "find"]).toString().trim().split(/\s+/)[1];
const windowShot = (name) => execFileSync(PYTHON, [WINDOW, "shot", hwnd(), `${outDir}/${name}`]);

const t0 = Date.now();
const c = await connect(port, "127.0.0.1:");
await c.send("Page.enable");
await c.send("Runtime.enable");
const errors = [];
c.on("Runtime.exceptionThrown", (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
c.on("Runtime.consoleAPICalled", (p) => p.type === "error" && errors.push(p.args.map((a) => a.value ?? a.description).join(" ")));
const step = (n, text, extra = "") => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${n}. ${text}${extra ? ` - ${extra}` : ""}`);
const toast = (text) => c.waitFor(`[...document.querySelectorAll("[data-sonner-toast]")].some((t) => t.textContent.includes(${JSON.stringify(text)}))`, 10000, `toast "${text}"`);
const lane = (name) => `[...document.querySelectorAll('section[aria-labelledby="lane-${name}"] li a')].map((a) => a.textContent.trim())`;
const CTRL = 2;

// 1. Start
await c.waitFor(`document.querySelector("main h1")?.textContent`, 20000, "first page");
step(1, "started", await c.evaluate(`document.querySelector("main h1").textContent`));
await sleep(400);
await c.shot(`${outDir}/01-start.png`);
windowShot("01-start-window.png");

// 2. Two to-dos, one sentence each: the date is recognised before saving
for (const sentence of ["周五前交房租", "明天下午3点开组会"]) {
  await c.click("button", "添加待办");
  await c.waitFor(`document.activeElement?.id === "task-quick"`, 10000, "the sentence field");
  await c.type(sentence);
  const preview = await c.waitFor(
    `[...document.querySelectorAll("[role=dialog] p, [role=dialog] span")].map((e) => e.textContent).find((t) => t.startsWith("将添加「") && t.includes("，"))`,
    10000,
    "the recognised date",
  );
  step(2, `"${sentence}"`, preview);
  if (sentence === "周五前交房租") await c.shot(`${outDir}/02-add.png`);
  await c.click("[role=dialog] button[type=submit]", "添加待办");
  await toast("任务已创建");
  await c.waitFor(`!document.querySelector("[role=dialog]")`, 10000, "the dialog closed");
  await sleep(500);
}
const todo = await c.waitFor(`(${lane("todo")}).length === 2 && ${lane("todo")}`, 10000, "both in the to-do lane");
step(2, "on the board under 待办", JSON.stringify(todo));
await c.shot(`${outDir}/03-board.png`);

// 3. Start the first: it moves to "进行中", where it shows that status
const [first, second] = todo;
await c.click(`[aria-label=${JSON.stringify(`开始处理「${first}」`)}]`);
await c.waitFor(`${lane("in_progress")}.includes(${JSON.stringify(first)})`, 10000, "moved to 进行中");
step(3, "started", `${first} -> 进行中`);
await sleep(400);
await c.shot(`${outDir}/04-in-progress.png`);
windowShot("04-in-progress-window.png");

// 4. Delete the second for good (its status menu -> 删除任务…)
await c.click(`section[aria-labelledby="lane-todo"] li button[aria-label^="状态："]`);
await c.click("[role=menuitem]", "删除任务…");
await c.waitFor(`document.querySelector("[role=alertdialog]")?.textContent.includes(${JSON.stringify(`删除「${second}」？`)})`, 10000, "the delete question");
await sleep(300);
await c.shot(`${outDir}/05-delete.png`);
await c.click("[role=alertdialog] button", "永久删除");
await toast("已删除 1 项任务");
await c.waitFor(`!${lane("todo")}.includes(${JSON.stringify(second)})`, 10000, "gone from the board");
step(4, "deleted", second);

// 5. Tick the first off; it is listed under "已完成"
await c.click(`[aria-label=${JSON.stringify(`把「${first}」标记为已完成`)}]`);
await toast("撤销");
step(5, "ticked off", first);
await c.click("nav a", "全部任务");
await c.waitFor(`location.pathname === "/tasks"`);
await c.click("button[role=tab]", "已完成");
await c.waitFor(`[...document.querySelectorAll("main ul > li a")].some((a) => a.textContent.includes(${JSON.stringify(first)}))`, 10000, "in the completed tab");
step(5, "listed under 已完成", first);
await sleep(300);
await c.shot(`${outDir}/06-completed.png`);

// 6. The Pomodoro timer: start, the sidebar shows the time going down, pause, resume, stop
await c.click("nav a", "番茄钟");
await c.waitFor(`location.pathname === "/focus"`);
await c.click("main button", "开始专注");
await c.waitFor(`document.querySelector("main")?.textContent.includes("专注中")`, 10000, "focusing");
const navTime = `document.querySelector('nav a[href="/focus"]')?.textContent.match(/\\d\\d:\\d\\d/)?.[0]`;
const before = await c.waitFor(navTime, 5000, "the time in the sidebar");
await sleep(2200);
const after = await c.evaluate(navTime);
step(6, "focusing", `sidebar ${before} -> ${after}`);
if (!(after < before)) errors.push(`the sidebar time did not go down (${before} -> ${after})`);
await c.shot(`${outDir}/07-focus.png`);
windowShot("07-focus-window.png");
await c.click("main button", "暂停");
await c.waitFor(`[...document.querySelectorAll("main button")].some((b) => b.textContent.includes("继续"))`, 10000, "paused");
step(6, "paused", await c.evaluate(navTime));
await c.click("main button", "继续");
await c.waitFor(`[...document.querySelectorAll("main button")].some((b) => b.textContent.includes("暂停"))`, 10000, "running again");
await c.click("main button", "停止");
await c.waitFor(`[...document.querySelectorAll("main button")].some((b) => b.textContent.includes("开始专注"))`, 10000, "stopped");
step(6, "stopped");

// 7. A 5-second countdown: it ends by itself, with a notification
await c.click("nav a", "倒计时");
await c.waitFor(`location.pathname === "/timers"`);
const fields = `[...document.querySelectorAll("form input[type=number]")]`;
await c.waitFor(`${fields}.length === 3`, 5000, "the duration fields");
for (const [index, value] of [[0, "0"], [1, "0"], [2, "5"]]) {
  await c.evaluate(`${fields}[${index}].scrollIntoView({ block: "nearest" })`);
  const point = await c.evaluate(`(() => { const r = ${fields}[${index}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await c.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  }
  await c.key("a", "KeyA", 65, CTRL);
  await c.type(value);
}
await c.click("#countdown-label");
await c.type("desktop-check");
await c.click("form button[type=submit]", "开始倒计时");
await c.waitFor(`!!document.querySelector('[role=timer][aria-label^="desktop-check"]')`, 10000, "the countdown running");
step(7, "countdown started", await c.evaluate(`document.querySelector('[role=timer][aria-label^="desktop-check"]').getAttribute("aria-label")`));
await c.shot(`${outDir}/08-countdown.png`);
await c.waitFor(`document.querySelector('section[aria-labelledby="countdowns-finished"]')?.textContent.includes("desktop-check")`, 20000, "the countdown finished");
const notes = await c.evaluate(`fetch("/api/notifications").then((r) => r.json()).then((n) => n.items.map((i) => i.title + ": " + i.body))`);
step(7, "countdown finished", JSON.stringify(notes.slice(0, 2)));
if (!notes.some((n) => n.startsWith("倒计时结束: desktop-check"))) errors.push("no notification for the countdown");
await sleep(300);
await c.shot(`${outDir}/09-countdown-finished.png`);
windowShot("09-countdown-finished-window.png");

// 8. The guide lives in the settings
await c.click('a[href="/settings"]', "设置");
await c.waitFor(`location.pathname === "/settings"`);
await c.click("button", "入门指南");
await c.waitFor(`document.querySelector("#guide-title")?.textContent === "入门指南"`, 10000, "the guide");
step(8, "guide in the settings", await c.evaluate(`document.querySelectorAll("#guide ol > li").length + " steps"`));
await c.shot(`${outDir}/10-guide.png`);

console.log(errors.length ? `PAGE ERRORS:\n${errors.join("\n")}` : "no page errors");
c.close();
process.exit(errors.length ? 1 : 0);
