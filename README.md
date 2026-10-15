# Tot — 本地 Markdown 浏览器

一个简洁的 Windows 桌面 Markdown 浏览器：选一个目录，浏览、编辑、搜索里面全部 `.md` 文件，12 套渲染风格一键切换。

Electron + 原生 JavaScript，无前端框架、无构建工具，离线可用。

## 下载

最新版本：[Releases](https://github.com/Verycaicai/Tot/releases)

- **Tot 1.1.0.exe** — 便携版，双击即用，无需安装
- **Tot Setup 1.1.0.exe** — 安装版

## 功能

- **文件树导航**：选择目录后左侧列出全部 `.md` / `.markdown` 文件（含子目录），可折叠；拖动边线调整面板大小
- **多标签页**：同时打开多个文档，切换保留滚动位置；未保存的更改关闭时确认
- **编辑与保存**：双栏实时预览（左侧编辑、右侧 300ms 实时渲染）；Ctrl+S 或编辑模式的「保存」按钮落盘，按原文件换行风格（CRLF/LF）还原
- **文件内查找**：Ctrl+F 高亮全部匹配、计数、上下跳转
- **大纲**：按标题层级生成，点击跳转，滚动时自动高亮当前章节
- **12 套渲染风格**：GitHub 亮/暗、极简、Read the Docs、Notion 亮/暗、Typora White/Night、Obsidian、Dracula、Nord、Monokai；选择自动记住
- **代码语法高亮**：highlight.js（常见 30+ 语言），每套风格独立配色
- **Callout 标注块**：`> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`
- **本地图片**：md 内相对路径图片正常显示（`mdfile://` 协议，路径限制在所选目录内）
- **自动记住上次目录**：重启后自动恢复

## 使用

| 操作 | 方式 |
|---|---|
| 打开文件夹 | 菜单 文件 → 打开文件夹（Ctrl+Shift+O） |
| 打开文件 | 菜单 文件 → 打开文件（Ctrl+O） |
| 保存 | 菜单 文件 → 保存 / Ctrl+S / 编辑模式保存按钮 |
| 编辑/预览切换 | 顶栏「编辑 / 预览」按钮 |
| 查找 | Ctrl+F |
| 切换标签页 | Ctrl+Tab / Ctrl+Shift+Tab |

## 开发

```bash
npm install
npm start        # 运行开发版
npm run dist     # 打包（electron-builder：安装版 + 便携版）
```

技术栈：Electron 44 + marked + highlight.js + github-markdown-css（全部 vendored 在 `lib/`）。

## 已知限制

- 带 BOM 的文件保存后 BOM 不保留（内容不变）
- 面板拖动尺寸不持久化
- 更换目录后旧标签页仍可查看缓存，但保存会被拒绝
- 不监听文件系统外部变化
- 安全起见不支持内联 HTML（全部转义显示）

## License

[MIT](LICENSE) © 2026 Verycaicai
