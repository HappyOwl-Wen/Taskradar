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
  都不会删除数据。Google 日历的授权保存在 Windows 凭据管理器中。
  导出或删除全部数据：设置 → 数据与隐私。

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
Data: %LOCALAPPDATA%\TaskRadar (outside the program folder); the Google Calendar sign-in in the Windows
Credential Manager.
[folder]Portable: keep the folder together (TaskRadar.exe needs its _internal folder).
Autostart is optional (Settings -> System & advanced).
