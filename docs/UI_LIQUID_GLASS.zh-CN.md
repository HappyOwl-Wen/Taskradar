# Liquid Glass 界面与回退

2026-10-24。参考用户提供的日历布局、Apple 胶囊导航和透明 Dock 图片。

## 存档

开始修改前，已把工作区原有的所有已修改文件和新增文件提交保存：

- 原始界面标签：`ui-before-liquid-glass-20261024`
- 原始界面分支：`codex/ui-before-liquid-glass-20261024`
- 原始界面提交：`b35361e29d30ff263d51203615cf001f894ab3bb`
- 第一版磨砂方案另存为标签：`ui-frosted-iteration-20261024`
- 当前方案分支：`codex/liquid-glass-ui`

存档保留了修改开始前尚未提交的桌面服务、日历页面、测试和文档，不仅是最后一个历史版本。
Git 保存源码，不包含用户数据库、账号凭据和构建产物。

## 当前材质

这一版使用几何生成的透镜位移贴图和 SVG `feDisplacementMap` 处理**页面实际背景**。
圆角与边缘按曲面法线及玻璃折射率计算采样偏移；中央保持平直，文字与图标不进入折射滤镜。
背景只做 0.35 px 的轻微平滑，不使用上一版 32–40 px 的大范围模糊。
双层反光边、内侧暗边和随指针变化的高光补充厚度感。

顶部胶囊导航浮在滚动页面上，因此滚动内容经过导航背后时也会发生折射。
侧边栏使用深色透明材质；日历工具栏、菜单、弹窗、概览卡片和 AI 侧栏共享同一光学实现。
背景丝带为本地 SVG，Outfit 字体也已随应用保存，不需要外部 CDN。

这是 Web/WebView 内的光学模拟，透明范围是应用页面内的背景，不会透视到 Windows 桌面。
Chromium 和桌面版 WebView2 启用 SVG 背景折射；其他引擎保留低模糊透明材质与玻璃边框。
系统要求减少透明度或提高对比度时停用折射并切换为实色，要求减少动画时停用指针追随高光。
Canvas 不可用时保留 CSS 材质，避免影响软件功能。

位移贴图仅来自面板宽高和圆角，不截图、不读取页面内容。贴图按尺寸缓存，缩放结束后合并更新；
静止时没有持续的 JavaScript 动画循环。

## 验证

- 前端 209 项测试、ESLint、TypeScript 与生产构建全部通过。
- 透镜中心不偏移、相对边缘对称、圆角双轴折射、小尺寸边界及 Canvas 失败回退测试。
- 侧边栏日期快捷入口、时区跨日和日历内日期跳转测试。
- 桌面启动与重启相关的 51 项后端测试，以及改动的 Python 文件的 Ruff 检查。
- Chromium 中使用同一实际材质对照清晰网格，确认边缘网格确实弯曲而标签保持清晰；
  检查浅色、深色及窄窗口布局。预览使用隔离的演示数据库和 Fake Calendar。

光学实现：`frontend/src/lib/liquidGlass.ts`、`frontend/src/components/ui/LiquidGlassEffects.tsx`。
设计样式：`frontend/src/glass.css`。截图位于 `docs/screenshots/liquid-glass-*`。

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
