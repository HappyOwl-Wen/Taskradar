TaskRadar {version} - 个人待办雷达 / personal obligation radar
==============================================================

启动
  双击 TaskRadar.exe。浏览器会打开 http://127.0.0.1:8000（只有这台电脑能访问）。
  黑色窗口表示 TaskRadar 正在运行；关闭这个窗口即可停止。不需要安装 Python 或 Node.js。
  这个程序没有数字签名，第一次启动时 Windows 可能提示“Windows 已保护你的电脑”：
  点“更多信息”，再点“仍要运行”。

数据
  数据库、导入的文件和日志保存在 %LOCALAPPDATA%\TaskRadar，不在这个文件夹里；
  删除或替换这个文件夹不会删除数据。Gmail 授权和 API Key 保存在 Windows 凭据管理器中。
  导出或删除全部数据：设置 → 数据与隐私。

识别扫描件和截图（可选）
  双击 Install-OCR.cmd 安装 Tesseract（需要 7-Zip；下载约 110 MB，逐个校验 SHA-256；
  不需要管理员权限，只写入 %LOCALAPPDATA%\TaskRadar\tools）。装好后刷新页面即可。

注意
{keep-together-zh}  开机自动启动是可选设置（设置 → 系统与高级选项），只有你确认后才会创建。
  以后如果移动了这个文件夹，请在那里关闭再重新开启自动启动。

--------------------------------------------------------------
Start: double-click TaskRadar.exe; your browser opens http://127.0.0.1:8000 (this computer only).
The black window means TaskRadar is running; close it to stop. No Python or Node.js needed.
Not code-signed: if Windows SmartScreen asks, choose "More info" and then "Run anyway".
Data: %LOCALAPPDATA%\TaskRadar (outside this folder); secrets in the Windows Credential Manager.
OCR (optional): double-click Install-OCR.cmd (needs 7-Zip; about 110 MB, checked by SHA-256).
{keep-together-en}Autostart is optional
(Settings -> System & advanced); after moving the folder, turn it off and on again.
