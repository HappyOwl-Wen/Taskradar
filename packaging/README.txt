TaskRadar {version} - 本地待办工具 / local to-do app
===================================================

安装（推荐）
  运行 TaskRadar-Setup-{version}.exe：安装到 %LOCALAPPDATA%\Programs\TaskRadar（只为当前用户，
  不需要管理员权限），并在开始菜单（可选：桌面）创建 TaskRadar 图标。卸载：Windows 设置 → 应用 →
  已安装的应用 → TaskRadar（你的数据会保留）。

便携版（不安装）
  解压 TaskRadar-{version}-windows-x64.zip，双击 TaskRadar.exe。

使用
  TaskRadar 在自己的窗口中打开。点窗口的 × 后，它留在任务栏右下角的托盘里，提醒、番茄钟和倒计时
  继续运行；在托盘图标上右键选“退出 TaskRadar”才会退出（也可以在设置中改为点 × 直接退出）。
  不需要安装 Python 或 Node.js。需要 Microsoft Edge WebView2 运行时（Windows 11 已自带）。
  这个程序没有数字签名，第一次启动时 Windows 可能提示“Windows 已保护你的电脑”：
  点“更多信息”，再点“仍要运行”。

数据
  数据库和日志保存在 %LOCALAPPDATA%\TaskRadar，不在程序文件夹里；更新、卸载或删除程序文件夹
  都不会删除数据。Google 日历的授权和 AI Agent 的 API Key 保存在 Windows 凭据管理器中。
  导出或删除全部数据：设置 → 数据与隐私。

日历与 AI 助手
  左侧「日历」查看截止日、工作时段和选中的 Google 日历。右上角机器人按钮打开可调整宽度的聊天侧栏。
  AI Agent 为可选功能，需要在设置中填写自己的 Claude、OpenAI 或兼容服务 API Key。
  消息和助手按需查询的相关待办/日历数据会发送至所选服务商，API 使用费用由服务商收取。
  默认受限模式先预览再应用；YOLO 模式自动应用本轮方案。模型与思考等级在输入框底部切换。

注意
[folder]  便携版请让整个文件夹保持在一起：TaskRadar.exe 需要旁边的 _internal 文件夹。
  开机自动启动是可选设置（设置 → 系统与高级选项），只有你确认后才会创建。

--------------------------------------------------------------
Install (recommended): run TaskRadar-Setup-{version}.exe. It installs to %LOCALAPPDATA%\Programs\TaskRadar
(current user, no administrator rights) with a Start menu entry and, if you like, a desktop shortcut.
Uninstall in Windows Settings -> Apps -> Installed apps -> TaskRadar (your data is kept).
Portable: unzip TaskRadar-{version}-windows-x64.zip and double-click TaskRadar.exe.
TaskRadar opens in its own window. Closing the window keeps it in the tray (bottom right of the taskbar), where
reminders, the Pomodoro timer and countdowns go on; right-click its icon and choose "Quit TaskRadar" to end it (or
let the close button quit, in the settings). No Python or Node.js needed; uses the Microsoft Edge WebView2 Runtime
(part of Windows 11).
Not code-signed: if Windows SmartScreen asks, choose "More info" and then "Run anyway".
Data: %LOCALAPPDATA%\TaskRadar (outside the program folder); Google Calendar sign-in and Agent API keys in the
Windows Credential Manager. The calendar shows deadlines, work blocks and selected Google calendars.
The optional AI Agent requires your own Claude, OpenAI or compatible API key. Messages and relevant workspace
data queried by the Agent go to that provider, whose API charges apply. Restricted mode previews changes before
Apply; optional YOLO applies the current turn's proposals automatically. Model/thinking controls are in the composer.
[folder]Portable: keep the folder together (TaskRadar.exe needs its _internal folder).
Autostart is optional (Settings -> System & advanced).
