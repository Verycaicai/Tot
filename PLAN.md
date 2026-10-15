# Tot — 本地 MD 文件浏览器 — 实现方案

应用名：**Tot**（package.json name: `tot`；productName / 窗口标题 / exe 名：`Tot`）

## 目标与成功标准

选一个本地目录 → 浏览其中全部 .md 文件 → 渲染阅读，12 套渲染风格可选，自动生成大纲；支持多标签页、双栏实时预览编辑保存、文件内查找、面板拖拽，自动记住上次目录。

1.1 成功标准（全部满足才算完成）：

1. 窗口标题 Tot；顶栏无文字/无打开文件夹按钮；菜单栏 文件/编辑/视图/窗口（文件含打开文件 Ctrl+O、打开文件夹 Ctrl+Shift+O、保存 Ctrl+S；窗口含关于 Tot 与 MIT 许可协议）
2. 多标签页：打开多个文件成 tab，开关切换滚动恢复、dirty 关闭确认、全部关闭回空态
3. 编辑：双栏实时预览（左 textarea + 右渲染，300ms debounce）、Ctrl+S 落盘（按原文件换行风格还原）、dirty 回显、越界路径拒写、编辑模式出现保存按钮（预览模式变灰）
4. 搜索：Ctrl+F 文件内查找，高亮/计数/上下跳转，重渲染后自动重应用
5. 拖拽：文件夹导航与大纲框可拖动大小（sidebar 200–600px / outline 120–600px clamp）
6. 重启自动恢复上次目录（userData/config.json）
7. 12 套渲染风格切换生效 + localStorage 持久化 + 暗色外壳无亮色残块 + 代码块 highlight.js 语法高亮（每套风格独立 token 配色）+ Callout 标注块（`> [!NOTE]` 等 5 类）+ 代码块底色与风格背景对比明显
8. 全量自动化断言通过、测试数据零污染、打包 exe 干净目录双击可用、代码推送 GitHub

## 技术选型

- Electron（44.7.2）+ 原生 JS。**无前端框架、无构建工具**（渲染层就是静态 HTML+JS+CSS）
- Markdown 解析：marked（UMD 版，vendored 到 `lib/`，离线可用）
- 代码语法高亮：highlight.js 11.11.1（common 语言集 vendored），渲染后对 `pre code` 调 `hljs.highlightElement`（有 language class 用之，否则自动检测）；token 配色按 12 套风格各写一份（6 个颜色桶），不走 hljs 官方主题（避免多主题全局类互相覆盖）
- 风格样式：github-markdown-css（light / dark vendored）+ 10 个手写 css（minimal / rtd / notion-light / notion-dark / typora-white / typora-night / obsidian / dracula / nord / monokai / shell-github-dark）
- 安全基线：`contextIsolation: true`、`nodeIntegration: false`；渲染进程不碰 Node API，全部通过 preload 的 contextBridge 白名单 IPC（select-directory / select-file / read-file / write-file / resolve-images / onDirectorySelected / onMenuCommand）；CSP `default-src 'none'` 白名单
- 图片：自定义协议 `mdfile://` 映射本地绝对路径（`protocol.handle`），路径校验限制在所选根目录内
- 记住目录：主进程 userData/config.json（不用 localStorage——渲染层不可信，不提供「提交任意 rootDir」的 IPC）

## 项目结构

```
md-browser/
├── package.json      # devDependencies: electron, electron-builder；main → main.js
├── main.js           # 主进程：窗口/菜单、目录扫描、文件读写、mdfile:// 协议、config、dev 验证钩子
├── preload.js        # contextBridge 暴露 7 个白名单 API
├── renderer/
│   ├── index.html    # 顶栏(搜索条+编辑/保存按钮+风格选择) + 左栏(文件树+大纲) + tab 条 + 双栏正文
│   ├── app.js        # 多标签页、双栏编辑、查找、大纲/scrollspy、拖拽、12 套风格注册表
│   ├── base.css      # 应用布局与控件样式（与渲染风格无关的部分）
│   └── styles/       # 手写渲染风格（每套 = 正文排版，7 套暗色另含外壳配色块）
└── lib/              # 全部第三方 vendored 文件
    ├── marked.min.js
    ├── highlight.min.js
    ├── github-markdown-light.css
    └── github-markdown-dark.css
```

## 关键设计

### 进程分工

- **主进程**：原生菜单（menu-command 推送）、目录/文件对话框、递归扫描（只收 .md/.markdown，跳过 `.git`/`node_modules`）、readFile 按需读、writeFile 落盘（isInside 边界校验）、`protocol.handle('mdfile')` 读图片、config.json 记住 lastDir
- **preload**：contextBridge 白名单 7 个 API
- **渲染进程**：全部 UI 逻辑

### 多标签页

- `tabs: [{id, path, name, text, dirty, mode, lineEnding, scrollTop, el}]`；单 #viewer 复用；openFile 已开则激活否则新开；**序号令牌**防慢 readFile 晚到覆盖当前 tab
- 关闭激活 tab 切邻居；dirty 关闭 → 自绘 #close-confirm 浮条（不用 window.confirm——同步阻塞会挂死自动化）
- 切换 tab：缓存 text 重渲染 → outline → 恢复 scrollTop → 树 active 恢复

### 编辑与保存

- 「编辑/预览」切换按钮：互存滚动位置；编辑模式 = 左 textarea + 右 #edit-viewer 实时渲染（input 即时同步 text/dirty，300ms debounce 渲染，切 tab/切模式 cancel 且回调内校验）
- 保存唯一入口 = 菜单 Ctrl+S 与编辑模式保存按钮（同一函数）：写盘按 tab.lineEnding 还原 \r\n/\n；渲染层**不监听** Ctrl+S 防菜单 accelerator 双触发

### 查找（Ctrl+F）

- TreeWalker 收集活动渲染区文本节点（跳过 script/style/mark）→ 大小写不敏感 → `mark.tot-search` 高亮全部 + `.current` 区分 → prev/next scrollIntoView；渲染管线末尾统一 applySearch（重渲染后自动重应用，幂等）

### 渲染与大纲

- `marked.parse()` 套 `markdown-body` + 当前风格 class；覆盖 html renderer 转义原始 HTML；图片相对路径改写为 mdfile://
- 标题 slugify + 序号去重 → 大纲缩进列表；IntersectionObserver scrollspy（root 随预览/编辑模式切换）；点击跳转
- 渲染管线顺序：parse → fixImages → hljs 高亮 → callout 转换 → headingIds → applySearch

### Callout 标注块

- blockquote 首段 `[!NOTE/TIP/IMPORTANT/WARNING/CAUTION]` 转 `.callout.callout-<type>`：彩色标题行（emoji + 中文标签）+ rgba 半透明底 + 主题色边框
- 亮色 5 套共用 styles/callouts.css，暗色 7 套共用 styles/callouts-dark.css（rgba 底在任何风格背景上自然融合）；选择器 `body[class]`（属性选择器 = 类级特异性）压过各风格 blockquote 规则

### 风格注册表（12 套）

- `STYLES = [{id, group, label, files[]}]` 单一数据源；惰性创建 `<link data-style-id>`，applyStyle 只 enabled 当前 id 的 link + body.className + localStorage；style-select 的 optgroup 由注册表生成
- 分组：GitHub（github-light/github-dark）、极简（minimal）、文档（rtd/notion-light/notion-dark/typora-white/typora-night/obsidian）、代码编辑器（dracula/nord/monokai）
- 旧 localStorage 值 light/dark 经 LEGACY 映射迁移并回写

### 面板拖拽

- document 级 pointermove/up + dragState 标志（不用 setPointerCapture——合成 PointerEvent 无真实 pointerId 会抛错）；sidebar width clamp 200–600px、outline height clamp 120–600px（inline px 覆盖百分比）

### 菜单

- 文件（打开文件/打开文件夹/保存/退出）、编辑（撤销/重做/剪切/复制/粘贴/全选，role 实现）、视图（重新加载/缩放/全屏/开发者工具，role 实现）、窗口（最小化/关闭/关于 Tot/ MIT 许可协议对话框）

## 里程碑与验证点

- **M0 环境** — ✅ Node v24.20.0 / npm 11.19.0
- **M1 骨架** — ✅ `npm start` 窗口打开，DevTools 无报错
- **M2 目录与文件树** — ✅ 树完整、排序正确、文件夹可折叠
- **M3 渲染与风格** — ✅ 表格/代码块/图片渲染，风格切换，重启保持
- **M4 大纲** — ✅ 生成 + 跳转 + scrollspy 高亮跟随
- **M5 打包** — ✅ 1.0.0 便携 exe 干净目录双击可用
- **M6 菜单 + 顶栏 + 打开文件 + 记住目录** — ✅ [dev:menu]/[dev:restore] 断言
- **M7 多标签页** — ✅ [dev:tabs1-6]：去重激活、scrollTop 恢复、空态、dirty 确认/取消/丢弃
- **M8 双栏实时预览编辑 + 保存** — ✅ [dev:edit1-7]：双栏、dirty、debounce、磁盘写入+复原零污染、越界拒写
- **M9 文件内查找** — ✅ [dev:search1-4]：3 匹配、计数、上下跳转、编辑右栏重应用、Esc 清除
- **M10 面板拖拽** — ✅ [dev:drag1-4]：宽度/上下限 clamp/outline 高度
- **M11 12 套风格 + 菜单扩展 + 保存按钮 + 语法高亮 + Callout** — ✅ [dev:check3] 12 套逐一断言（body class、唯一 enabled link、optgroup=4、options=12、localStorage、正文与外壳计算样式、pre 底色、callout 配色），24 张截图目检；[dev:edit0/5b] 保存按钮灰/可用态；[dev:check1] hljsSpans 断言 token span 生成、callouts 断言 5 类标注块与中文标题
- **M12 收尾** — 本版最终验证 + 1.1.0 打包 + 推送

## 已知限制（1.1）

- BOM 丢失：读文件按 utf8 解码，带 BOM 的 md 保存后 BOM 不保留（内容不变）
- 面板尺寸不持久化：sidebar/outline 拖动尺寸重启后还原默认
- 跨目录旧 tab 只读：换目录后旧 tab 仍可看缓存内容，保存被 isInside 拒绝并回显错误
- 不监听文件系统变化：外部修改文件需重开
- 不支持内联 HTML（安全起见全部转义）

## 明确不做（留作后续）

- md 相对链接跳转（点 `[xxx](other.md)` 打开对应文件）
- 全文搜索（跨文件）
- 更多风格（GitLab/MDN/Logseq/学术论文/思源宋体/报纸等）

## 风险与前提

1. Node 已装（v24.20.0 LTS）。开发脚本里可用全路径 `C:\Program Files\nodejs\node.exe` 兜底；Bash 会话需 `export PATH="/c/Program Files/nodejs:$PATH"`
2. 大目录扫描：异步 + 只收 md；实测卡顿再做懒加载
3. Windows 长路径/无权限文件：扫描时 try/catch 跳过读不了的项
4. 开发验证钩子（TOT_* 环境变量 + [dev:*] 断言输出）保留在 main.js dev 块中，不进入打包版路径
