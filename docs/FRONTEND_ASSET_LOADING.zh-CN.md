# 界面更新后的动态脚本加载失败

2026-10-24。修复前存档：`ui-before-asset-loading-fix-20261024`。

## 原因与证据

页面通过 React.lazy 在首次进入某个功能时加载带哈希名的脚本。
之前 Vite 使用 `emptyOutDir: true`，每次生产构建会清空后端正在提供的静态目录。
已打开的页面仍持有旧版入口和旧脚本 URL，切换到尚未打开的任务页时就请求到了已删除的文件。
React.lazy 还会缓存这次失败，继续在同一文档内重试无法获取新入口。

修复前实际检查：

- 截图中的 `/assets/TasksPage-CKdeieXb.js` 返回 404。
- 当时当前构建的 `/assets/TasksPage-C05AYCB_.js` 返回 200。
- `/tasks` 的 HTML 返回 200 且已设置 `Cache-Control: no-cache`。这个响应头不会替换已打开文档中的旧 import 引用。

## 修复

- 构建设置 `emptyOutDir: false`，保留已有哈希脚本和样式，继续为旧页面提供资源。
- `frontend/tooling/publishIndexLast.ts` 将 HTML 留到所有新资源写好后再发布，通过同目录临时文件和 rename 切换入口。
  生成失败时旧入口保持可用；Windows 文件短暂占用时有限重试，不发布半份 HTML。
- 识别动态模块与预加载样式失败，显示本地化说明和“重新加载当前页面”。重新加载保留路径、筛选参数和日期参数。
  不自动刷新；其他渲染异常仍显示原来的错误信息，方便排查。

历史哈希资源会保留在构建目录，以支持仍打开的页面。不要在服务运行且存在旧页面时清空该目录。
任务数据库、账号凭据与后端服务逻辑没有改动。

## 验证

- 228 项前端测试、ESLint、TypeScript 与生产构建通过。
- 真实 Vite 构建回归：连续构建 A/B 后，A 的动态脚本及 CSS 仍可读取；B 的资源全部写好前入口仍指向 A；
  注入构建失败后原入口保持不变。
- 四类模块/CSS 加载错误的恢复文案与按钮测试，验证保持原页面及筛选参数；普通渲染错误继续保留诊断信息。
- 使用隔离演示数据库，在浏览器中先打开旧首页，随后对正式静态目录构建新版，再进入任务页：
  旧入口 `index-hkeakTw4.js` 仍成功加载 `TasksPage-C05AYCB_.js`，浏览器无运行错误。
  实际 8000 端口同时能读取旧任务脚本和新任务脚本 `TasksPage-ujSLLwLp.js`（均为 200）。
- 在静态资源副本和独立端口中暂时移走任务脚本，确认出现恢复提示；恢复脚本后点击“重新加载当前页面”，
  成功回到 `/tasks`。该故障注入没有改动用户数据或正式静态资源。

截图：

- `screenshots/asset-loading-after-update.png`：旧页面在新构建发布后仍正常进入任务页。
- `screenshots/asset-loading-retry.png`：独立环境故障注入时的恢复提示。
- `screenshots/asset-loading-recovered.png`：恢复脚本并重新加载后的任务页。
