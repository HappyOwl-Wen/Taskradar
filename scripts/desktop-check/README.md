# Checking the desktop window

`flow.mjs` drives the real TaskRadar window like a user with the mouse — start → add content (files through the
Windows file chooser) → confirm what was found → look at the tasks → tick one off and find it under "已完成" — and
saves screenshots of the page and of the whole window with its title bar. It talks to the window's WebView2 through
the Chrome DevTools Protocol, which TaskRadar opens only when `TASKRADAR_WEBVIEW_DEBUG_PORT` is set (for tests;
never set it for daily use: any local program could then control the page).

Requirements: Windows, Node.js 22+ (for `fetch` and `WebSocket`), the backend's `.venv` (Pillow, for the window
screenshots; another Python with Pillow can be named in `PYTHON`). The interface must be in Chinese (the default).

```powershell
# 1. Start TaskRadar on an empty scratch data folder, so your own data is never touched.
$env:TASKRADAR_WEBVIEW_DEBUG_PORT = "9222"
Start-Process dist\TaskRadar\TaskRadar.exe -ArgumentList "--data-dir", "$env:TEMP\taskradar-check"
Remove-Item Env:\TASKRADAR_WEBVIEW_DEBUG_PORT

# 2. Run the flow with one or more synthetic sample files (close other TaskRadar windows first).
node scripts\desktop-check\flow.mjs 9222 build\desktop-check `
  backend\src\taskradar\demo\samples\06_en_rental_contract.pdf `
  backend\src\taskradar\demo\samples\01_zh_enrollment_certificate_notice.pdf
```

The source version works the same way (`backend\.venv\Scripts\python.exe -m taskradar desktop --data-dir …`).
Each step is printed with its time; the exit code is 1 when a step does not happen or the page reports an error.

`window.py find` lists TaskRadar windows (process, handle, size in physical pixels, DPI, maximised/minimised);
`window.py shot <handle> <file.png>` captures one with its title bar.

中文：`flow.mjs` 在真实的 TaskRadar 窗口中按用户操作走完“启动 → 添加内容 → 确认任务 → 查看任务 → 完成任务”，
并保存页面和整个窗口的截图。只在测试时设置 `TASKRADAR_WEBVIEW_DEBUG_PORT`，并用临时数据目录启动，避免碰到你自己的数据。
