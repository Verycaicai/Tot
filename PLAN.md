# 本地 MD 文件浏览器 — 实现方案

形态：**Electron 桌面应用**（2026-10-15 定稿，待确认后实施）

应用名：**Tot**（package.json name: `tot`；productName / 窗口标题 / exe 名：`Tot`）

## 目标与成功标准

选一个本地目录 → 浏览其中全部 .md 文件 → 渲染阅读，渲染风格可切换，自动生成大纲。

成功标准（全部满足才算完成）：

1. 启动应用，窗口打开，工具栏可用
2. 任选本地目录 → 左侧列出该目录（含子目录）全部 .md / .markdown 文件；点击文件即渲染
3. 3 套渲染风格（GitHub 亮 / GitHub 暗 / 极简）一键切换，重启后保持
4. 大纲：按标题层级缩进、点击跳转、正文滚动时高亮当前章节
5. md 内相对路径图片正常显示
6. `npm start` 可运行开发版；electron-builder 打包出 Windows exe，双击可用

## 技术选型

- Electron（最新稳定版，package.json 锁定版本）+ 原生 JS。**无前端框架、无构建工具**（不用 Vite/webpack，渲染层就是静态 HTML+JS+CSS）
- Markdown 解析：marked（UMD 版，vendored 到 `lib/`，离线可用，不依赖 node_modules 路径）
- 风格样式：github-markdown-css（light / dark 两个文件 vendored）+ 手写 minimal.css
- 安全基线（Electron 标准做法）：`contextIsolation: true`、`nodeIntegration: false`；渲染进程不碰 Node API，全部通过 preload 的 contextBridge 白名单 IPC
- 图片：自定义协议 `mdfile://` 映射本地绝对路径（`protocol.handle`），路径校验限制在所选根目录内

## 项目结构

```
md-browser/
├── package.json      # devDependencies: electron, electron-builder；main → main.js
├── main.js           # 主进程：创建窗口、打开目录对话框、文件扫描/读取、mdfile:// 协议
├── preload.js        # contextBridge 暴露: openDirectory() / readFile(path)
├── renderer/
│   ├── index.html    # 顶栏(打开目录/风格切换) + 左栏(文件树+大纲) + 正文
│   ├── app.js        # 文件树渲染、marked 渲染、大纲生成、scrollspy、风格切换
│   ├── base.css      # 应用布局与控件样式（与渲染风格无关的部分）
│   └── styles/
│       └── minimal.css   # 手写极简排版
└── lib/              # 全部第三方 vendored 文件
    ├── marked.min.js
    ├── github-markdown-light.css
    └── github-markdown-dark.css
```

## 关键设计

### 进程分工

- **主进程**：`dialog.showOpenDialog` 选目录 → 异步递归扫描（只收 .md/.markdown，跳过 `.git`/`node_modules` 等）→ 返回树；`readFile` 按需读文件内容；`protocol.handle('mdfile')` 读图片
- **preload**：contextBridge 暴露两个方法：`openDirectory()`、`readFile(path)`
- **渲染进程**：全部 UI 逻辑

### 文件树

- 文件夹可折叠（`<details>/<summary>`），文件夹与文件各自按名称排序
- 扫描一次性异步完成（md 文件即使几千个也无压力）；不做懒加载

### 渲染

- `marked.parse()` 输出套上 `markdown-body` class + 当前风格的 class
- 安全：覆盖 marked 的 html renderer 把原始 HTML 转义（约 5 行），防止本地 md 内嵌脚本执行；代价是不支持内联 HTML，后续需要再上 DOMPurify
- 图片：渲染后把 `img[src]` 的相对路径按「当前文件所在目录」解析为绝对路径，改写为 `mdfile://` URL；协议处理器校验路径在所选根目录内后返回文件

### 大纲（outline）

- 用 `marked.lexer()` 取 heading token（带 depth），生成 h1–h6 全部层级的缩进列表
- 渲染时给每个标题加 id（文本 slugify + 序号去重），大纲项点击 → `scrollIntoView` 平滑滚动
- scrollspy：IntersectionObserver 观察所有标题，视口内最靠上的标题在大纲中高亮
- 左栏下半段固定高度、自身可滚动（长文档）

### 风格切换

- 顶栏下拉 3 项，切换 = 换 body class；localStorage 记住选择

### 打包

- electron-builder 出 NSIS 安装包 / 便携 exe，仅最后一步做

## 里程碑与验证点

- **M0 环境**：安装 Node.js LTS + npm — ✅ 已完成（Node v24.20.0 / npm 11.19.0，winget 安装）
- **M1 骨架**：package.json + main.js + preload + 空页面 → `npm start` 窗口打开，DevTools 无报错
- **M2 目录与文件树**：打开目录 → 扫描 → 树展示 → 验证：选 Sonic 仓库 docs 目录，文件树完整、排序正确、文件夹可折叠
- **M3 渲染与风格**：marked + 3 套样式 + 图片改写 → 验证：打开含表格/代码块/图片的 md，三套风格外观正确、图片显示、重启后风格保持
- **M4 大纲**：生成 + 跳转 + scrollspy → 验证：用 Sonic 长文档（如 README.md）滚动，高亮跟随；点击任意标题定位准确
- **M5 打包**：electron-builder 出 exe → 验证：拷到干净目录双击可用

## 明确不做（本期）

- 编辑/保存、搜索、多标签页
- 自动记住上次目录（localStorage 存路径即可实现，需要随时加）
- md 相对链接跳转（点 `[xxx](other.md)` 打开对应文件，留作后续）
- 代码语法高亮（highlight.js，留作后续）

## 风险与前提

1. Node 已装（v24.20.0 LTS）。注意：安装前已启动的终端 / VS Code 需重启才能拿到新 PATH；开发脚本里可用全路径 `C:\Program Files\nodejs\node.exe` 兜底
2. 大目录（如整个 Sonic 仓库）扫描：异步 + 只收 md；实测卡顿再做懒加载
3. Windows 长路径/无权限文件：扫描时 try/catch 跳过读不了的项

## 假设（不对请纠正）

- 「渲染风格可选」= 3 套外观预设（GitHub 亮/暗/极简）；想要 Typora 风、Notion 风等可再加
- 只读浏览器，不做编辑
- 交付物为 Windows exe
