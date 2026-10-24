# Liquid Glass 界面与回退

2026-10-24。参考用户提供的日历布局、Apple 胶囊导航和透明 Dock 图片。

## 存档

开始修改前，已把工作区原有的所有已修改文件和新增文件提交保存：

- 原始界面标签：`ui-before-liquid-glass-20261024`
- 原始界面分支：`codex/ui-before-liquid-glass-20261024`
- 原始界面提交：`b35361e29d30ff263d51203615cf001f894ab3bb`
- 第一版磨砂方案另存为标签：`ui-frosted-iteration-20261024`
- 弹性切换与日历快捷入口改动前：`ui-before-liquid-motion-20261024`
- 弹窗正文可读性修复前：`ui-before-dialog-reading-20261024`
- 二级菜单弹跳动画改动前：`ui-before-popup-spring-20261024`
- 动态脚本加载失败修复前：`ui-before-asset-loading-fix-20261024`
- 按钮形变与菜单衔接改动前：`ui-before-trigger-morph-20261024`
- 平滑动画、边框衔接与性能修复前：`ui-before-smooth-performance-20261024`（`ce8d388`）
- 本次平滑动画与性能修复版本：`ui-smooth-glass-20261024`
- 收起侧栏对齐修复前：`ui-before-rail-alignment-fix-20261024`（`9dcdfba`）
- 侧栏对齐修复版本：`ui-rail-aligned-20261024`
- 被撤回的浮雕方案存档：`ui-before-ios-clear-glass-20261024`（`d185c8a`）
- 仅撤回浮雕、保留此前修复：`ui-relief-reverted-20261024`（`c575ee0`）
- 按 iOS 参考收细轮廓的版本：`ui-ios-clear-glass-20261024`
- 当前方案分支：`codex/liquid-glass-ui`

存档保留了修改开始前尚未提交的桌面服务、日历页面、测试和文档，不仅是最后一个历史版本。
Git 保存源码，不包含用户数据库、账号凭据和构建产物。

## 当前材质

这一版使用几何生成的透镜位移贴图和 SVG `feDisplacementMap` 处理**页面实际背景**。
圆角与边缘按曲面法线及玻璃折射率计算采样偏移；中央保持平直，文字与图标不进入折射滤镜。
光学滤镜直接处理清晰背景，移除了额外的模糊与饱和度通道。
细轮廓、轻微反射与背景边缘折射表现透明材质；指针追随高光只在小控件上更新，避免大面板持续重绘。

顶部胶囊导航浮在滚动页面上，因此滚动内容经过导航背后时也会发生折射。
侧边栏使用深色透明材质；日历工具栏、菜单、弹窗、概览卡片和 AI 侧栏共享同一光学实现。
背景丝带为本地 SVG，Outfit 字体也已随应用保存，不需要外部 CDN。

这是 Web/WebView 内的光学模拟，透明范围是应用页面内的背景，不会透视到 Windows 桌面。
Chromium 和桌面版 WebView2 启用 SVG 背景折射；其他引擎保留低模糊透明材质与玻璃边框。
系统要求减少透明度或提高对比度时停用折射并切换为实色，要求减少动画时停用指针追随高光。
Canvas 不可用时保留 CSS 材质，避免影响软件功能。

位移贴图仅来自面板宽高和圆角，不截图、不读取页面内容。几何计算和 PNG 编码在 Worker/OffscreenCanvas 中完成，
按尺寸合并请求并缓存最多 96 份；不支持时使用最大边 128 px 的同步回退。
缩放结束后合并更新；静止时没有持续的 JavaScript 动画循环。

## 验证

- 前端 245 项测试、ESLint、TypeScript 与生产构建全部通过。
- 透镜中心不偏移、相对边缘对称、圆角双轴折射、小尺寸边界及 Canvas 失败回退测试。
- 侧边栏日期快捷入口、时区跨日和日历内日期跳转测试。
- 桌面启动与重启相关的 51 项后端测试，以及改动的 Python 文件的 Ruff 检查。
- Chromium 中使用同一实际材质对照清晰网格，确认边缘网格确实弯曲而标签保持清晰；
  检查浅色、深色及窄窗口布局。预览使用隔离的演示数据库和 Fake Calendar。

光学实现：`frontend/src/lib/liquidGlass.ts`、`frontend/src/components/ui/LiquidGlassEffects.tsx`。
设计样式：`frontend/src/glass.css`。截图位于 `docs/screenshots/liquid-glass-*`。

### 导航弹层在缩放下的遮挡修复

导航抽屉现在明确使用 `surface="navigation"`，不再叠加通用 `glass-dialog` 材质。
菜单文字区使用独立的实色读取层，玻璃折射保留在外缘；打开时隐藏下方导航导轨，并将主界面
设为 `inert`。菜单通过 body 中的 Portal 弹出，继续保留遮罩、键盘焦点约束和 Esc 关闭，
关闭后恢复打开按钮的焦点。点击遮罩不会触发下面的卡片。

滚动发生在菜单内部，外部读取层与关闭按钮保持固定，避免低高度窗口滚动后再次穿透。
已验证触发问题的 1088 × 956、设备像素比 1.25 的布局，以及 360 × 320 和 840 × 480 的真实页面视口。
新增三项集成回归测试，覆盖独立 Portal、底层禁用、焦点约束、Esc 恢复和导航后的交互恢复。
修复截图为 `liquid-glass-navigation-fixed.png`，短窗口滚动截图为 `liquid-glass-navigation-viewports.png`。

### 共享平滑切换、菜单可读性与日期快捷入口

导航、任务筛选、设置分区、番茄钟阶段、倒计时方式、日历视图和侧栏日期统一使用持续存在的玻璃选中层。
选中层以 240 ms 单调减速曲线移动，平滑落稳；连续点击会从当前显示位置重新计算。
通过 Web Animations API 提交 transform 关键帧，浏览器合成动画，静止时没有逐帧 JavaScript 计算。
移动时保留 SVG 背景折射，尺寸变化时重用或异步准备透镜位移贴图；系统要求减少动画时直接定位。
页面与分区只让标题轻量淡入，避免整棵玻璃元素树一起缩放或改变透明度。
新增分组可通过 `data-selection-scope` 使用相同实现，侧栏折叠时选中层的尺寸变化也会平滑衔接。

“添加待办”使用 36 px 高的玻璃胶囊按钮。原来的 `svg:only-child` 选择器会忽略文字节点，
误将图标加文字的按钮设为圆形；现在仅对显式的图标尺寸按钮应用圆形边框。
下拉菜单使用独立的读取底色（浅色 94%、深色 95%），边缘继续保留折射与反光，避免透出下方文字和按钮。

侧栏每一天直接进入 `/calendar?date=YYYY-MM-DD&view=timeGridDay`，覆盖之前保存的月/周视图偏好。
日视图查询单日范围，展示当天截止任务、工作时段和日程；空日期显示提示。前后翻日会同步 URL、日期输入和侧栏选中状态。
今天用独立标记保留，与当前浏览的日期区分。

测试覆盖切换起止位置、单调运动、尺寸变化、日视图偏好、侧栏连续跳日、前后翻日及空日期。
隔离演示数据库中已实测上述各类切换，检查动画运行时折射滤镜持续存在，并验证菜单文字清晰。
截图：`liquid-glass-select-readable.png`、`liquid-glass-day-shortcut.png`、`liquid-glass-task-switch.png`。
实现：`frontend/src/components/ui/LiquidSelectionEffects.tsx`、`frontend/src/lib/liquidMotion.ts` 和 `frontend/src/liquid-motion.css`。

### 表单弹窗正文遮挡

通用表单、确认框和计时结束提醒使用不透明的 `--popover` 正文底色，阻止下方任务文字穿透。
通过 `background-clip: padding-box` 将底色限制在正文区域，外侧保留 2 px 的透明折射边缘与高光。
背景由弹窗自身绘制，滚动时无需额外的绝对定位遮挡层；也不依靠提高模糊强度消除重影。
导航抽屉继续使用独立材质。

隔离演示数据中验证了浅色、深色和展开“更多选项”的表单，确认正文不透字、SVG 折射滤镜继续存在，
浏览器没有运行错误。220 项前端测试、ESLint 和 TypeScript/生产构建均通过。
截图：`liquid-glass-dialog-readable.png`、`liquid-glass-dialog-readable-dark.png`。

### 从触发按钮展开的二级菜单

共用的下拉菜单、通知/状态浮层、选择框和提示使用同一套 280 ms 平滑动画：从按钮附近的小尺寸展开，
以 `cubic-bezier(.16, 1, .3, 1)` 减速停稳，不再过冲或回弹。关闭时用 140 ms 向原按钮方向收回。
CSS 根据 Radix 实际放置方向、对齐方式、
触发按钮尺寸和间距设置缩放起点；上、下、左、右弹出都适用，定位仍由 Radix 的外层负责。
选择框的原有 translate 间距改为 Popper sideOffset，使显示位置与动画起点一致。
系统要求减少动画时沿用全局无动画规则。

玻璃菜单插入 Portal 后立即请求折射贴图，无需等待通用尺寸更新的 75 ms 防抖；命中缓存时立即应用。
回归测试在不推进计时器的情况下验证缓存/回退路径。浏览器实测“更多”菜单向下展开和任务选择框向上展开，
最终缩放起点与按钮中心误差小于 0.1 px，动画过程中仍有 SVG 背景折射，关闭动画及通知浮层正常。
221 项测试、ESLint、类型检查及生产构建通过。截图：`liquid-glass-popup-spring.png`。

### 界面更新后的脚本加载失败

已修复连续构建清掉旧脚本、导致未刷新的页面无法切换到任务页的问题。
构建保留旧哈希资源，在新脚本与样式全部落盘后原子切换 HTML 入口；模块加载失败时提供重新加载当前页面的恢复入口。
原因、回归测试及实际浏览器验证见 [前端资源加载修复记录](FRONTEND_ASSET_LOADING.zh-CN.md)。

### 按钮形变与菜单衔接

所有共用 DropdownMenu、Popover 和 Select 触发按钮自动接入玻璃形变。按钮先压缩蓄力，再朝菜单实际放置方向拉伸，
菜单在 60 ms 后开始展开，形成连续动作；按钮玻璃层和图标在 320 ms 内完成一次轻微压缩、延伸和复位。
形变幅度按按钮尺寸限制，宽选择框不会大幅横向扩张。

`PopupTriggerEffects.tsx` 只给按钮添加 `aria-hidden` 的装饰透镜层，并读取 `aria-expanded`、`aria-controls` 和菜单 `data-side`。
按钮的边框、底色和阴影统一绘制到变形透镜上，解决原边框留在原地的问题。
按钮本体保留布局边框宽度，但边框色、底色和背景滤镜清空；点击区域及 Popper 定位锚点保持静止。
选择框静止时也使用同一装饰透镜绘制边框，键盘焦点光环跟随透镜，深浅主题均使用语义颜色。
文字翻译或 React 更新移除装饰层后会自动补回；关闭和再次打开不会重复添加装饰层。
动画交给 CSS 合成，JavaScript 只在状态和几何变化时更新；系统减少动画时取消形变与衔接延时。

浏览器验证了鼠标、键盘打开“更多”以及任务选择框向上展开，原框已透明，边框和折射由形变层绘制。
按钮朝实际菜单方向略微延伸，菜单接着展开；按钮位置和点击区域保持不变，透镜滤镜持续存在。
新增三项真实 Radix 控件集成测试，覆盖 Tooltip 包裹、Esc 焦点恢复、再次打开、方向翻转、文字更新、卸载清理与键盘选择。
231 项测试、ESLint 和 TypeScript/生产构建通过。截图：`liquid-glass-trigger-handoff.png`。

### 搜索框融合与高刷新率优化

顶部搜索输入改为透明、无内框，直接使用顶栏玻璃底材。键盘聚焦时只给输入区域一个轻量外光环，搜索提交行为保持正常。

侧栏不再逐帧改变宽度：先提交一次布局，再以 200 ms 合成变换移动工作区、伸缩独立侧栏材质。
页面文字不缩放，选中层跟随尺寸变化。快速反向操作会取消旧动画并从当前显示位置续接，结束后清理 `will-change`。
光学计算离开主线程，布局读取集中在样式写入之前；几何缓存避免反复生成相同透镜。

244 项前端测试、ESLint 与类型/生产构建通过。测试包括 Worker 去重/缓存/失败回退/卸载清理、
合成动画中断、减少动画偏好、无 Web Animations API 回退，以及选中层尺寸变化。
浏览器验证了浅色、深色、搜索提交、选择框边框与菜单方向。
性能数据和高刷新率验证范围见 [玻璃动画性能记录](GLASS_MOTION_PERFORMANCE.zh-CN.md)。
截图：`liquid-glass-smooth-focus.png`、`liquid-glass-smooth-focus-dark.png`。

### 收起侧栏的错位与裁切修复

复现时侧栏名义宽度为 76 px，但带负 inset 的玻璃装饰层使滚动区多出约 1 px 的高度，触发纵向滚动条。
实际内容容器只剩 48 px，默认 Grid 最小内容宽度又被长标签撑到约 68 px，造成图标偏右、选中背景和文字被裁切。
此前只验证选中层与条目是否重合，未验证条目是否超出侧栏；本次补充了后者。

玻璃材质现在固定在外壳中，滚动内容使用独立的 `.sidebar-scroll`；装饰层不进入滚动范围。
选中层的定位范围也移到该滚动区，保持随内容滚动。菜单使用 `minmax(0, 1fr)` 列和可收缩条目，
中英文长标签可在固定宽度内换行。收起模式保留滚动功能并隐藏占宽的滚动条，让正常及短窗口的图标都与外壳中心对齐。
展开/收起继续使用原有合成动画，不恢复逐帧宽度动画。

Chromium 中用真实页面的同源 iframe 检查了 1202 × 956、1202 × 540、840 × 480、1088 × 956 四种视口。
全部通过图标/条目居中、文字不横向溢出、选中层匹配、材质与外壳同尺寸的检查。
932 px 高的正常滚动区不再出现多余溢出，短窗口只保留内容需要的纵向滚动。
另验证了保存收起状态后重新加载、连续四次反向切换、展开模式和英文长标签。
测量数据见 [RAIL_ALIGNMENT_SAMPLES.json](RAIL_ALIGNMENT_SAMPLES.json)，截图为 `liquid-glass-rail-aligned.png`。

新增集成测试确保玻璃装饰层在展开与收起之间始终位于滚动区之外，滚动区不被重新挂载。
245 项前端测试、ESLint 与 TypeScript/生产构建通过；全新正式页面没有浏览器错误或警告。

### 撤回浮雕方案，按 iOS 参考调整

`c575ee0` 完整撤回 `d185c8a` 的曲面光照方案，恢复单张位移贴图，保留侧栏对齐、资源加载和交互修复。
该提交单独保留，可作为不含后续外观调整的纯回退版本。

后续样式以用户提供的 iOS 截图为参考：移除多层内阴影和宽亮边，轮廓降至 0.75 CSS px，减轻投影与大面积反射。
透镜曲面区域收窄，采样位移减小；真实背景仍通过原有 SVG 位移滤镜折射。
顶栏动作和选择器采用完整胶囊，顶栏图标保留透明圆形底材。菜单和表单仍有独立读取底色。
控件边框全部由变形层绘制，原锚点立即清空边框与底色，避免初次挂载的颜色过渡留下短暂原框。
高对比度偏好下恢复较强的控件轮廓，键盘焦点光环保持可见。

245 项测试、ESLint 与生产构建通过。浏览器验证了浅色、深色、胶囊选择器、菜单/表单读取底色、
无额外滚动条，以及收起侧栏 76 px 宽度与居中。正式页面无运行错误或警告。
截图：`liquid-glass-ios-clear.png`、`liquid-glass-ios-dark.png`、`liquid-glass-ios-select.png`。
这是 Web 中按参考方向进行的材质调整，不声称复现原生 iOS 的完整渲染行为。

## 回到原始界面

先提交或另行保存后续新增的修改，再在仓库根目录执行：

```powershell
git switch codex/ui-before-liquid-glass-20261024
cd frontend
npm run build
```

重新打开源码版 TaskRadar，或重新加载页面。重新构建是必要步骤，因为后端的静态资源不纳入 Git。
返回新方案时，在仓库根目录切换至 `codex/liquid-glass-ui`，再执行同样的前端构建。
此流程不改动任务、计时器或账号数据。

## 参考与字体许可

- [MDN：backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter)
- [MDN：feDisplacementMap](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feDisplacementMap)
- [Outfit 官方字体源](https://github.com/google/fonts/tree/main/ofl/outfit)；许可随文件保存在
  `frontend/public/fonts/Outfit-OFL.txt`。
