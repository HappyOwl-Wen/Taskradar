# Checking the desktop window

`flow.mjs` drives the real TaskRadar window like a user with the mouse and keyboard — start → add two to-dos with
one sentence each → start one (it moves to "进行中") → delete the other → tick the first off and find it under
"已完成" → run the Pomodoro timer (the sidebar shows its time going down; pause, resume, stop) → a 5-second countdown
that ends by itself with a notification → the guide in the settings — and saves screenshots of the page and of the
whole window with its title bar. It talks to the window's WebView2 through the Chrome DevTools Protocol, which
TaskRadar opens only when `TASKRADAR_WEBVIEW_DEBUG_PORT` is set (for tests; never set it for daily use: any local
program could then control the page).

Requirements: Windows, Node.js 22+ (for `fetch` and `WebSocket`), the backend's `.venv` (Pillow, for the window
screenshots; another Python with Pillow can be named in `PYTHON`). The interface must be in Chinese (the default).

```powershell
# 1. Start TaskRadar on an empty scratch data folder, so your own data is never touched.
$env:TASKRADAR_WEBVIEW_DEBUG_PORT = "9222"
Start-Process dist\TaskRadar\TaskRadar.exe -ArgumentList "--data-dir", "$env:TEMP\taskradar-check"
Remove-Item Env:\TASKRADAR_WEBVIEW_DEBUG_PORT

# 2. Run the flow (close other TaskRadar windows first).
node scripts\desktop-check\flow.mjs 9222 build\desktop-check
```

The source version works the same way (`backend\.venv\Scripts\python.exe -m taskradar desktop --data-dir …`).
Each step is printed with its time; the exit code is 1 when a step does not happen or the page reports an error.
The countdown's Windows notification itself is not checked by the flow (it checks TaskRadar's own notification
list); see Windows' notification center.

`window.py find` lists TaskRadar windows (process, handle, size in physical pixels, DPI, maximised/minimised);
`window.py shot <handle> <file.png>` captures one with its title bar.

中文：`flow.mjs` 在真实的 TaskRadar 窗口中按用户操作走完“启动 → 用一句话添加两条待办 → 开始处理一条（移到“进行中”）→
删除另一条 → 完成第一条并在“已完成”中找到 → 番茄钟（侧边栏显示倒数的时间；暂停、继续、停止）→ 5 秒倒计时自动结束并产生通知 →
设置中的入门指南”，并保存页面和整个窗口的截图。只在测试时设置 `TASKRADAR_WEBVIEW_DEBUG_PORT`，并用临时数据目录启动，
避免碰到你自己的数据。
