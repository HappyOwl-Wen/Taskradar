TaskRadar {version} - 个人待办雷达 / personal obligation radar
==============================================================

安装（推荐）
  运行 TaskRadar-Setup-{version}.exe：安装到 %LOCALAPPDATA%\Programs\TaskRadar（只为当前用户，
  不需要管理员权限），并在开始菜单（可选：桌面）创建 TaskRadar 图标。卸载：Windows 设置 → 应用 →
  已安装的应用 → TaskRadar（你的数据会保留）。

便携版（不安装）
  解压 TaskRadar-{version}-windows-x64.zip，双击 TaskRadar.exe。

使用
  TaskRadar 在自己的窗口中打开，本地服务随窗口启动和停止；关闭窗口即停止。不需要安装 Python 或
  Node.js。需要 Microsoft Edge WebView2 运行时（Windows 11 已自带）。
  这个程序没有数字签名，第一次启动时 Windows 可能提示“Windows 已保护你的电脑”：
  点“更多信息”，再点“仍要运行”。

数据
  数据库、导入的文件和日志保存在 %LOCALAPPDATA%\TaskRadar，不在程序文件夹里；
  更新、卸载或删除程序文件夹都不会删除数据。Gmail 授权和 API Key 保存在 Windows 凭据管理器中。
  导出或删除全部数据：设置 → 数据与隐私。

识别扫描件和截图（可选）
  双击程序文件夹中的 Install-OCR.cmd 安装 Tesseract（需要 7-Zip；下载约 110 MB，逐个校验 SHA-256；
  不需要管理员权限，只写入 %LOCALAPPDATA%\TaskRadar\tools）。装好后刷新页面即可。

注意
[folder]  便携版请让整个文件夹保持在一起：TaskRadar.exe 需要旁边的 _internal 文件夹。
  开机自动启动是可选设置（设置 → 系统与高级选项），只有你确认后才会创建。

--------------------------------------------------------------
Install (recommended): run TaskRadar-Setup-{version}.exe. It installs to %LOCALAPPDATA%\Programs\TaskRadar
(current user, no administrator rights) with a Start menu entry and, if you like, a desktop shortcut.
Uninstall in Windows Settings -> Apps -> Installed apps -> TaskRadar (your data is kept).
Portable: unzip TaskRadar-{version}-windows-x64.zip and double-click TaskRadar.exe.
TaskRadar opens in its own window; its local service starts and stops with the window. No Python or Node.js
needed; uses the Microsoft Edge WebView2 Runtime (part of Windows 11).
Not code-signed: if Windows SmartScreen asks, choose "More info" and then "Run anyway".
Data: %LOCALAPPDATA%\TaskRadar (outside the program folder); secrets in the Windows Credential Manager.
OCR (optional): double-click Install-OCR.cmd (needs 7-Zip; about 110 MB, checked by SHA-256).
[folder]Portable: keep the folder together (TaskRadar.exe needs its _internal folder).
Autostart is optional (Settings -> System & advanced).
