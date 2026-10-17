// Small CDP client for the TaskRadar desktop window (WebView2 started with TASKRADAR_WEBVIEW_DEBUG_PORT).
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";

export async function connect(port, urlPart = "127.0.0.1") {
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === "page" && t.url.includes(urlPart));
    } catch {
      /* not up yet */
    }
    if (!page) await sleep(100);
  }
  if (!page) throw new Error(`no page with ${urlPart} on port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  };
  const waitFor = async (expression, timeout = 10000, label = expression) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await evaluate(expression).catch(() => null);
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  /** Centre of the first element matching the selector whose text contains `text` (CSS pixels). */
  const centre = (selector, text = "") =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null && e.textContent.includes(${JSON.stringify(text)}));
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  /** A real mouse click (through the browser's input pipeline) on the element. */
  const click = async (selector, text = "") => {
    const point = await waitFor(`(${centreFn(selector, text)})()`, 10000, `${selector} "${text}"`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
    }
    return point;
  };
  const key = async (keyName, code = keyName, keyCode = 0, modifiers = 0) => {
    // Enter needs its character too: forms submit on the key press, not on the raw key-down.
    const down = keyName === "Enter" ? { type: "keyDown", text: String.fromCharCode(13), unmodifiedText: String.fromCharCode(13) } : { type: "rawKeyDown" };
    await send("Input.dispatchKeyEvent", { ...down, key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const type = (text) => send("Input.insertText", { text });
  const shot = async (path) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
  };
  return { send, on, evaluate, waitFor, centre, click, key, type, shot, close: () => ws.close() };
}

function centreFn(selector, text) {
  return `() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null && !e.closest('[inert]') && e.textContent.includes(${JSON.stringify(text)}));
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }`;
}
