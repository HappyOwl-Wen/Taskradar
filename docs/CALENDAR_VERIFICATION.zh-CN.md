# 日历工作台验证记录

日期：2026-10-22。源码目录：`C:\workspace\01_TUM\Project\02_TaskRadar`。

全部测试使用临时 SQLite 或 `build/calendar-check/` 下的独立合成数据，Google 凭据使用 MemorySecretStore，远端使用 FakeCalendarClient。没有进行真实 Google 登录，没有改动真实账号日程，也没有读取真实用户数据库。

## 自动化

| 检查 | 结果 |
| --- | --- |
| 后端完整 pytest | **292 passed** |
| 后端 ruff check | 通过 |
| 后端 ruff format --check | 99 个文件通过 |
| 后端 mypy | 84 个源文件通过 |
| 前端完整 Vitest | **123 passed，24 个测试文件** |
| 前端 eslint / TypeScript | 通过 |
| 前端生产构建 | 通过，产物写入 `backend/src/taskradar/static/` |
| 最后文字修正后的 i18n / CalendarEditor / calendar 测试 | 9 passed，构建再次通过 |
| git diff --check | 通过；已有 TaskEditDialog 的 CRLF 提示不影响检查 |

现有 SettingsPage 测试保留一条 React `act(...)` 提示，测试通过；本次没有改动该测试的路由回退逻辑。

新增后端测试位于 `backend/tests/test_calendar_workspace.py`，覆盖：

- 未连接 Google 的截止标记、待安排、工作时段创建、原截止日期保留、版本冲突和删除任务后保留工作计划。
- app/read/edit 权限组合、只读目标、共享日历的 writer 编辑、未选中目标、未开启编辑、缺少提交确认，以及 Google ACL 在打开界面后发生变化。
- 多日历及事件分页，旧任务镜像去重，只读会议、重复实例和特殊事件的展示及编辑限制。
- 普通事件修改传播、远端新增/修改/删除、PATCH 保留会议数据、提醒和附件。
- ETag 冲突保留用户和远端版本，显式重新检查后提交；旧关联任务的两种版本选择。
- 创建成功但响应丢失后的幂等重试；期间远端又修改时的可解决冲突。
- 断网、部分日历失败、分页失败、限流 Retry-After、授权失效等待、410 重建，以及全量结果已不含删除墓碑时的关联处理。
- 本地任务、其他日历缓存、工作计划及草稿在失败和重建过程中保留。
- 关联时段远端变更和删除的传播；普通事件不自动创建任务，主动关联操作可幂等重试。
- 全天排他结束边界、跨日、Europe/Berlin 2026-03-29 跳时和 2026-10-25 回拨，以及两次 02:30 的真实时长。
- OAuth 升级取消及缺失范围保留原令牌，账号切换不混合缓存，数据导出和清空包含新增数据。

新增前端测试位于 `frontend/src/lib/calendar.test.ts` 和 `frontend/src/components/calendar/CalendarEditor.test.tsx`，覆盖全天边界、DST 选次及实际时长、关联来源筛选、表单确认、远端失败保留输入，以及冲突双方展示与禁止盲目重试。完整套件同时通过原任务、自然语言时间解析、番茄钟、计时器、设置和旧 CalendarCard 流程。

## 界面

先使用真实 Windows 桌面壳（pywebview / Edge WebView2）打开独立测试窗口，验证侧栏入口、月视图、多个来源、日期标记、只读标识和键盘可访问的事件。后续使用同一代码的本地浏览器界面检查主要表单和响应式布局。

| 流程 / 环境 | 实际结果 |
| --- | --- |
| 中文浅色月视图，常规宽度 | 截止、工作时段、普通日程分开标识；旧任务镜像只出现一次；跨多日全天日程正确跨格 |
| 周视图 | 全天区、跨日分段及重叠布局可见；初始滚动到工作日时段；当前时间线由组件实时绘制 |
| 普通日程创建 | 标题、地点、描述可输入；提交确认列明标题、起止时间、目标日历；Fake Calendar 保存后立即出现 |
| 普通日程修改 | 修改标题后保存，列表正文和键盘/读屏名称均更新；发现并修复旧 aria-label 未更新的问题 |
| 普通日程删除 | 再次确认列明对象、时间、目标日历和独立删除规则；提交后该事件消失，其他任务及事件仍保留 |
| 只读的重复受邀会议 | 显示“只读”和复杂编辑说明，提供 Google 网页链接，未出现编辑或删除按钮 |
| 从待安排创建时段 | 表单明确显示 60 分钟，保存后待安排数量减少，工作块出现；详情有打开任务入口 |
| 540 × 820，英文深色日程列表 | 导航折叠、来源可换行、顶部操作和日期导航可用，列表连续展示全天及跨日内容 |
| 540 × 820，英文深色编辑表单 | 起止字段单列、描述区和底部确认按钮可访问，无横向溢出 |
| 完全未连接 Google 的独立实例 | 本地截止标记、待安排和工作时段入口可用；仅 Google 新建及刷新按钮禁用 |

本次没有逐个自动执行所有拖拽手势、Windows 10、多显示器缩放、完整读屏器朗读及真实 Google 服务端验收。拖拽后仍要求表单确认，具备等价的按钮和键盘入口。浏览器中两种语言/主题及窄窗口已经检查；桌面壳的窄尺寸组合未逐一重复全部流程。

## 截图

所有内容均为合成测试数据。

- [月视图，中文浅色](screenshots/calendar-month-light-zh.png)
- [只读会议详情](screenshots/calendar-readonly-light-zh.png)
- [窄窗口日程列表，英文深色](screenshots/calendar-agenda-dark-en-narrow.png)
- [窄窗口编辑表单，英文深色](screenshots/calendar-editor-dark-en-narrow.png)
- [未连接 Google 的本地日历](screenshots/calendar-local-light-zh.png)

## 复现

先在 `frontend` 执行 `npm ci`、`npm run build`，然后从项目根目录运行：

```powershell
# 合成多日历 + 真实桌面窗口；只在测试时启用调试端口 9234。
backend\.venv\Scripts\python.exe scripts\calendar-check\launch.py --desktop --data-dir build\calendar-check\new-review

# 完全不连接 Google 的浏览器实例。
backend\.venv\Scripts\python.exe scripts\calendar-check\launch.py --local --port 8135 --data-dir build\calendar-check\new-local
```

测试目录只能放在 `build/calendar-check/` 内，避免误用真实数据目录。每次完整复现使用新的目录；Fake Calendar 存在内存中，进程结束即重置。正常使用运行 `TaskRadar.cmd`，无需启用调试端口。

真实账号还需用户配置 Google Cloud OAuth 范围并在系统浏览器中授权。新范围可能需要 Google 项目额外验证；本次未以任何方式自动代替用户同意。已有安装程序尚未重新打包。
