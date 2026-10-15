'use strict';

// 兜底：宿主环境若带 ELECTRON_RUN_AS_NODE（VS Code 启动的终端会继承它），
// electron.exe 会退化为纯 Node。开发版下 require('electron') 返回 exe 路径字符串，
// 打包版下模块不存在（用 process.execPath，即 Tot.exe 自身）。
// 这种情况下用真正的 electron 重启自己。
// 注意：electron 对该变量按「是否存在」判断，空字符串也算存在，必须整键删除。
let electronRequire;
try {
  electronRequire = require('electron');
} catch {
  electronRequire = process.execPath;
}
if (typeof electronRequire === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.electron_run_as_node;
  require('child_process')
    .spawn(electronRequire, [__dirname], { stdio: 'inherit', env })
    .on('exit', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow, ipcMain, dialog, protocol, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');

// 验证时隔离 userData（须在 app ready 前设置）
if (process.env.TOT_USER_DATA) app.setPath('userData', process.env.TOT_USER_DATA);

// 自定义协议：mdfile://local/<绝对路径>，用于加载 md 内的本地图片
protocol.registerSchemesAsPrivileged([
  { scheme: 'mdfile', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let rootDir = null; // 当前选中的根目录，作为读文件 / 图片协议的边界
let win = null;

const SKIP_DIRS = new Set(['node_modules', '.git']);

// ---------- 目录扫描 ----------

// 递归收集 dir 下所有 .md / .markdown 文件；跳过 .git / node_modules 等目录；
// 不含任何 md 的空目录不出现在树里；读不了的目录静默跳过。
async function scanDir(dir) {
  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const item of items) {
    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name) || item.name.startsWith('.')) continue;
      const children = await scanDir(path.join(dir, item.name));
      if (children.length) dirs.push({ name: item.name, path: path.join(dir, item.name), type: 'dir', children });
    } else if (item.isFile() && /\.(md|markdown)$/i.test(item.name)) {
      files.push({ name: item.name, path: path.join(dir, item.name), type: 'file' });
    }
  }
  const cmp = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  dirs.sort(cmp);
  files.sort(cmp);
  return [...dirs, ...files];
}

// ---------- 路径边界 ----------

function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------- 记住上次目录 ----------

// userData/config.json：{ lastDir }。渲染层不可信，路径只由主进程的对话框产生
const configPath = () => path.join(app.getPath('userData'), 'config.json');

async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function saveConfig(patch) {
  const cfg = { ...(await loadConfig()), ...patch };
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

// ---------- IPC ----------

ipcMain.handle('select-directory', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  rootDir = res.filePaths[0];
  await saveConfig({ lastDir: rootDir });
  return { root: rootDir, tree: await scanDir(rootDir) };
});

// 打开单个 md 文件：以文件所在目录为边界，返回 { root, tree, file } 或 null
ipcMain.handle('select-file', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  rootDir = path.dirname(res.filePaths[0]);
  await saveConfig({ lastDir: rootDir });
  return { root: rootDir, tree: await scanDir(rootDir), file: res.filePaths[0] };
});

ipcMain.handle('read-file', async (_e, p) => {
  if (!rootDir || !isInside(rootDir, p)) throw new Error('路径在所选目录之外');
  const text = await fs.readFile(p, 'utf8');
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // 去掉 BOM
});

// 批量把 md 内 img 的相对 src 解析为 mdfile:// URL；远程 / data: 原样返回
ipcMain.handle('resolve-images', (_e, filePath, srcs) => {
  const base = path.dirname(filePath);
  return srcs.map((src) => {
    if (/^(https?:|data:|mdfile:)/i.test(src)) return src;
    const abs = path.resolve(base, src.replace(/\//g, path.sep));
    return 'mdfile://local/' + encodeURI(abs.replace(/\\/g, '/'));
  });
});

// 保存当前编辑内容（菜单 文件 → 保存 / Ctrl+S），与 read-file 同样的边界校验
ipcMain.handle('write-file', async (_e, p, text) => {
  if (!rootDir || !isInside(rootDir, p)) throw new Error('路径在所选目录之外');
  await fs.writeFile(p, text, 'utf8');
});

// ---------- 图片协议 ----------

function handleMdfile(request) {
  const p = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, '');
  if (!rootDir || !isInside(rootDir, p)) return new Response('forbidden', { status: 403 });
  return fs.readFile(p).then(
    (data) => {
      const mime = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
      }[path.extname(p).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { headers: { 'Content-Type': mime } });
    },
    () => new Response('not found', { status: 404 }),
  );
}

// ---------- 菜单 ----------

let appMenu = null;

const MIT_LICENSE = `MIT License

Copyright (c) 2026 Verycaicai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function buildMenu() {
  appMenu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '打开文件', accelerator: 'CmdOrCtrl+O', click: () => win?.webContents.send('menu-command', 'open-file') },
        { label: '打开文件夹', accelerator: 'CmdOrCtrl+Shift+O', click: () => win?.webContents.send('menu-command', 'open-folder') },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => win?.webContents.send('menu-command', 'save') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
        { type: 'separator' },
        {
          label: '关于 Tot',
          click: () => {
            if (!win) return;
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 Tot',
              message: 'Tot',
              detail: `版本 ${app.getVersion()}\n\n本地 Markdown 浏览器\nElectron + 原生 JavaScript`,
            });
          },
        },
        {
          label: 'MIT 许可协议',
          click: () => {
            if (!win) return;
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'MIT 许可协议',
              message: 'MIT License',
              detail: MIT_LICENSE,
            });
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);
}

// ---------- 窗口 ----------

function createWindow() {
  win = new BrowserWindow({
    title: 'Tot',
    icon: path.join(__dirname, 'Tot.png'),
    width: 1280,
    height: 840,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  buildMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 开发模式：渲染进程 console 转发到终端（验证「DevTools 无报错」用）
  if (!app.isPackaged) {
    win.webContents.on('console-message', (...args) => {
      const first = args[0];
      const e = typeof first === 'object' && first.message !== undefined
        ? first
        : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
  }

  win.on('closed', () => { win = null; });

  // 生产行为：启动时自动恢复上次打开的目录（无 TOT_OPEN_DIR 时）
  // 仅开发/自动验证用：TOT_OPEN_DIR 启动即打开该目录（跳过对话框）；
  // TOT_OPEN_FILE 按文件名自动打开一个文件；TOT_SCREENSHOT 截两张图（顶部 + 滚动后）后退出；
  // TOT_CHECK 在页面里跑断言并打印 DOM 状态（树/渲染/大纲/scrollspy）后退出
  win.webContents.on('did-finish-load', async () => {
    if (!process.env.TOT_OPEN_DIR) {
      const cfg = await loadConfig();
      if (cfg.lastDir) {
        rootDir = cfg.lastDir;
        win.webContents.send('directory-selected', { root: rootDir, tree: await scanDir(rootDir) });
      }
      if (process.env.TOT_CHECK) {
        await new Promise((r) => setTimeout(r, 800));
        console.log('[dev:restore]', await win.webContents.executeJavaScript(
          `JSON.stringify({ root: ${JSON.stringify(cfg.lastDir || null)}, treeFiles: [...document.querySelectorAll('#file-tree a')].map((a) => a.textContent) })`,
        ));
        app.quit();
      }
      return;
    }
    try {
      const dir = process.env.TOT_OPEN_DIR;
      rootDir = path.resolve(dir);
      if (process.env.TOT_SAVE_CONFIG) await saveConfig({ lastDir: rootDir });
      win.webContents.send('directory-selected', { root: rootDir, tree: await scanDir(rootDir) });
        if (process.env.TOT_OPEN_FILE) {
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === ${JSON.stringify(process.env.TOT_OPEN_FILE)})?.click()`,
          );
        }
        if (process.env.TOT_CHECK) {
          console.log('[dev:menu]', JSON.stringify({
            labels: appMenu.items.map((i) => i.label),
            fileItems: appMenu.items[0].submenu.items.map((i) => i.label ?? i.type),
            editItems: appMenu.items[1].submenu.items.map((i) => i.label ?? i.type),
            viewItems: appMenu.items[2].submenu.items.map((i) => i.label ?? i.type),
            windowItems: appMenu.items[3].submenu.items.map((i) => i.label ?? i.type),
            saveAcc: appMenu.items[0].submenu.items.find((i) => i.label === '保存')?.accelerator,
          }));
          await new Promise((r) => setTimeout(r, 800));
          const check = `JSON.stringify({
            treeFiles: [...document.querySelectorAll('#file-tree a')].map((a) => a.textContent),
            treeDirs: [...document.querySelectorAll('#file-tree summary')].map((s) => s.textContent),
            active: document.querySelector('#file-tree a.active')?.textContent ?? null,
            headings: [...document.querySelectorAll('#viewer h1,h2,h3,h4,h5,h6')].map((h) => h.id + ':' + h.tagName + ':' + h.textContent.slice(0, 12)),
            table: !!document.querySelector('#viewer table'),
            pre: !!document.querySelector('#viewer pre code'),
            hljsSpans: document.querySelectorAll('#viewer pre code .hljs-keyword, #viewer pre code .hljs-string, #viewer pre code .hljs-comment').length,
            callouts: [...document.querySelectorAll('#viewer .callout')].map((c) => c.className),
            calloutTitles: [...document.querySelectorAll('#viewer .callout-title')].map((t) => t.textContent),
            imgSrc: document.querySelector('#viewer img')?.getAttribute('src') ?? null,
            imgLoaded: (() => { const i = document.querySelector('#viewer img'); return i ? i.naturalWidth > 0 : null; })(),
            outline: [...document.querySelectorAll('#outline a')].map((a) => a.getAttribute('href')),
            outlineActive: document.querySelector('#outline a.active')?.getAttribute('href') ?? null,
            tabs: document.querySelectorAll('.tab').length,
            activeTab: document.querySelector('.tab.active .tab-name')?.textContent ?? null,
            style: document.body.className + '/' + (localStorage.getItem('tot-style') || 'none'),
          })`;
          console.log('[dev:check1]', await win.webContents.executeJavaScript(check));
          await win.webContents.executeJavaScript(
            `window.__scrollLog = []; document.querySelector('#preview-scroll').addEventListener('scroll', () => window.__scrollLog.push(performance.now().toFixed(0) + ':' + document.querySelector('#preview-scroll').scrollTop)); document.querySelectorAll('#viewer h3')[1]?.scrollIntoView({ block: 'start' });`,
          );
          await new Promise((r) => setTimeout(r, 700));
          console.log('[dev:check2]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              scrollTop: document.querySelector('#preview-scroll').scrollTop,
              active: document.querySelector('#outline a.active')?.getAttribute('href') ?? null,
              scrollLog: window.__scrollLog,
              headings: [...document.querySelectorAll('#viewer h1,h2,h3,h4,h5,h6')].map((h) => h.id + '@' + Math.round(h.getBoundingClientRect().top)),
            })`,
          ));
          if (process.env.TOT_STYLE) {
            // 驱动侧兼容旧风格名（light/dark），映射到注册表新 id
            const styleId = { light: 'github-light', dark: 'github-dark' }[process.env.TOT_STYLE] || process.env.TOT_STYLE;
            console.log('[dev:check3]', await win.webContents.executeJavaScript(
              `new Promise((resolve) => {
                const sel = document.querySelector('#style-select');
                sel.value = ${JSON.stringify(styleId)};
                sel.dispatchEvent(new Event('change'));
                setTimeout(() => {
                  const cs = getComputedStyle(document.querySelector('#viewer'));
                  resolve(JSON.stringify({
                    bodyClass: document.body.className,
                    links: [...document.querySelectorAll('link[data-style-id]')]
                      .map((l) => l.dataset.styleId + (l.disabled ? ':off' : ':on'))
                      .filter((s) => s.endsWith(':on')),
                    linkCount: document.querySelectorAll('link[data-style-id]').length,
                    optgroups: document.querySelectorAll('#style-select optgroup').length,
                    options: document.querySelectorAll('#style-select option').length,
                    stored: localStorage.getItem('tot-style'),
                    viewerBg: cs.backgroundColor,
                    viewerColor: cs.color,
                    shellBg: [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('#topbar')).backgroundColor, getComputedStyle(document.querySelector('#editor')).backgroundColor, getComputedStyle(document.querySelector('#tabbar')).backgroundColor],
                    preStyle: (() => { const p = getComputedStyle(document.querySelector('#viewer pre')); return { bg: p.backgroundColor, border: p.borderTopColor }; })(),
                    calloutStyle: (() => { const c = getComputedStyle(document.querySelector('#viewer .callout-note')); const t = getComputedStyle(document.querySelector('#viewer .callout-note .callout-title')); return { bg: c.backgroundColor, border: c.borderLeftColor, title: t.color }; })(),
                  }));
                }, 400);
              })`,
            ));
          }
        }
        if (process.env.TOT_TABS) {
          await new Promise((r) => setTimeout(r, 800));
          // tabs1: 打开第二个文件 → 两个标签页
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === '02-第二章.md')?.click()`,
          );
          await new Promise((r) => setTimeout(r, 600));
          console.log('[dev:tabs1]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              count: document.querySelectorAll('.tab').length,
              names: [...document.querySelectorAll('.tab-name')].map((s) => s.textContent),
              active: document.querySelector('.tab.active .tab-name')?.textContent ?? null,
              h1: document.querySelector('#viewer h1')?.textContent?.slice(0, 8) ?? null,
            })`,
          ));
          // tabs2: 重复点同一文件 → 只激活不新增
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === '02-第二章.md')?.click()`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:tabs2]', await win.webContents.executeJavaScript(
            `JSON.stringify({ count: document.querySelectorAll('.tab').length })`,
          ));
          // tabs3: tab0 滚动到 150 → 切 tab1 → 切回 tab0，断言滚动恢复
          await win.webContents.executeJavaScript(`document.querySelectorAll('.tab')[0].click()`);
          await new Promise((r) => setTimeout(r, 500));
          await win.webContents.executeJavaScript(`document.querySelector('#preview-scroll').scrollTop = 150`);
          await new Promise((r) => setTimeout(r, 300));
          await win.webContents.executeJavaScript(`document.querySelectorAll('.tab')[1].click()`);
          await new Promise((r) => setTimeout(r, 500));
          await win.webContents.executeJavaScript(`document.querySelectorAll('.tab')[0].click()`);
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:tabs3]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              active: document.querySelector('.tab.active .tab-name')?.textContent ?? null,
              scrollTop: document.querySelector('#preview-scroll').scrollTop,
              h1: document.querySelector('#viewer h1')?.textContent?.slice(0, 8) ?? null,
            })`,
          ));
          // tabs4: 关闭全部标签 → 空态
          await win.webContents.executeJavaScript(`[...document.querySelectorAll('.tab-close')].forEach((b) => b.click())`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:tabs4]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              tabCount: document.querySelectorAll('.tab').length,
              emptyShown: !document.querySelector('#empty').hidden,
              panesHidden: document.querySelector('#panes').hidden,
            })`,
          ));
          // tabs5/6: dirty 关闭确认——编辑改字 → 关闭弹确认条 → 取消 → 再关并丢弃
          await win.webContents.executeJavaScript(`[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === 'README.md')?.click()`);
          await new Promise((r) => setTimeout(r, 500));
          await win.webContents.executeJavaScript(`document.querySelector('#edit-toggle').click()`);
          await new Promise((r) => setTimeout(r, 300));
          await win.webContents.executeJavaScript(
            `const ed = document.querySelector('#editor'); ed.value = ed.value + 'x'; ed.dispatchEvent(new Event('input', { bubbles: true }));`,
          );
          await new Promise((r) => setTimeout(r, 200));
          await win.webContents.executeJavaScript(`document.querySelector('.tab-close').click()`);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:tabs5]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              confirmShown: !document.querySelector('#close-confirm').hidden,
              tabStillThere: document.querySelectorAll('.tab').length === 1,
            })`,
          ));
          await win.webContents.executeJavaScript(`document.querySelector('#close-cancel').click()`);
          await new Promise((r) => setTimeout(r, 200));
          await win.webContents.executeJavaScript(`document.querySelector('.tab-close').click()`);
          await new Promise((r) => setTimeout(r, 200));
          await win.webContents.executeJavaScript(`document.querySelector('#close-discard').click()`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:tabs6]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              tabCount: document.querySelectorAll('.tab').length,
              emptyShown: !document.querySelector('#empty').hidden,
            })`,
          ));
        }
        if (process.env.TOT_EDIT) {
          const editFile = path.join(rootDir, process.env.TOT_OPEN_FILE || 'README.md');
          await new Promise((r) => setTimeout(r, 800));
          // edit0: 预览模式下保存按钮变灰不可操作
          console.log('[dev:edit0]', await win.webContents.executeJavaScript(
            `JSON.stringify({ saveDisabled: document.querySelector('#save-btn').disabled })`,
          ));
          // edit1: 切到编辑模式
          await win.webContents.executeJavaScript(`document.querySelector('#edit-toggle').click()`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:edit1]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              editPane: !document.querySelector('#edit-pane').hidden,
              previewHidden: document.querySelector('#preview-scroll').hidden,
              editorHasText: document.querySelector('#editor').value.length > 0,
              toggleLabel: document.querySelector('#edit-toggle').textContent,
              saveDisabled: document.querySelector('#save-btn').disabled,
              editViewerH1: document.querySelector('#edit-viewer h1')?.textContent?.slice(0, 8) ?? null,
            })`,
          ));
          // edit2: 插入标记文本 → dirty 出现
          await win.webContents.executeJavaScript(
            `const ed = document.querySelector('#editor');
             ed.value = ed.value + '\\n\\n**TOT编辑测试段落**';
             ed.dispatchEvent(new Event('input', { bubbles: true }));`,
          );
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:edit2]', await win.webContents.executeJavaScript(
            `JSON.stringify({ dirty: !document.querySelector('.tab-dirty').hidden })`,
          ));
          // edit3: debounce 后右栏渲染出标记
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:edit3]', await win.webContents.executeJavaScript(
            `JSON.stringify({ rendered: document.querySelector('#edit-viewer').textContent.includes('TOT编辑测试段落') })`,
          ));
          // edit4/5: 点保存按钮保存，断言磁盘真的被改
          const before = await fs.readFile(editFile, 'utf8');
          await win.webContents.executeJavaScript(`document.querySelector('#save-btn').click()`);
          await new Promise((r) => setTimeout(r, 700));
          const after = await fs.readFile(editFile, 'utf8');
          console.log('[dev:edit4]', JSON.stringify({
            diskChanged: after !== before,
            dirtyGone: await win.webContents.executeJavaScript(`document.querySelector('.tab-dirty').hidden`),
          }));
          console.log('[dev:edit5]', JSON.stringify({
            diskHasMarker: after.includes('TOT编辑测试段落'),
            status: await win.webContents.executeJavaScript(`document.querySelector('#save-status').textContent`),
          }));
          // edit5b: 切回预览模式 → 保存按钮变灰不可操作
          await win.webContents.executeJavaScript(`document.querySelector('#edit-toggle').click()`);
          await new Promise((r) => setTimeout(r, 400));
          console.log('[dev:edit5b]', await win.webContents.executeJavaScript(
            `JSON.stringify({ toggleLabel: document.querySelector('#edit-toggle').textContent, saveDisabled: document.querySelector('#save-btn').disabled })`,
          ));
          // edit6: 经 write-file IPC 恢复原内容，测试数据零污染
          await win.webContents.executeJavaScript(
            `window.tot.writeFile(${JSON.stringify(editFile)}, ${JSON.stringify(before)})`,
          );
          await new Promise((r) => setTimeout(r, 300));
          const restored = await fs.readFile(editFile, 'utf8');
          console.log('[dev:edit6]', JSON.stringify({ restored: restored === before }));
          // edit7: 越界路径被拒
          console.log('[dev:edit7]', JSON.stringify({
            result: await win.webContents.executeJavaScript(
              `window.tot.writeFile('C:/Windows/System32/tot-test.txt', 'x').then(() => 'ok', (e) => 'err')`,
            ),
          }));
        }
        if (process.env.TOT_SEARCH) {
          await new Promise((r) => setTimeout(r, 800));
          // search1: Ctrl+F 开搜索条，输入查询
          await win.webContents.executeJavaScript(
            `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
             const si = document.querySelector('#search-input');
             si.value = ${JSON.stringify(process.env.TOT_SEARCH_QUERY || '测试')};
             si.dispatchEvent(new Event('input', { bubbles: true }));`,
          );
          await new Promise((r) => setTimeout(r, 300));
          console.log('[dev:search1]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              barShown: !document.querySelector('#searchbar').hidden,
              marks: document.querySelectorAll('#viewer mark.tot-search').length,
              count: document.querySelector('#search-count').textContent,
              currentIdx: [...document.querySelectorAll('#viewer mark.tot-search')].findIndex((m) => m.classList.contains('current')),
            })`,
          ));
          // search2: 下一个
          await win.webContents.executeJavaScript(`document.querySelector('#search-next').click()`);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:search2]', await win.webContents.executeJavaScript(
            `JSON.stringify({ currentIdx: [...document.querySelectorAll('#viewer mark.tot-search')].findIndex((m) => m.classList.contains('current')) })`,
          ));
          // search3: 编辑模式下右栏重渲染后搜索仍应用
          await win.webContents.executeJavaScript(`document.querySelector('#edit-toggle').click()`);
          await new Promise((r) => setTimeout(r, 500));
          console.log('[dev:search3]', await win.webContents.executeJavaScript(
            `JSON.stringify({ marksInEditViewer: document.querySelectorAll('#edit-viewer mark.tot-search').length })`,
          ));
          // search4: Esc 关闭并清除高亮
          await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:search4]', await win.webContents.executeJavaScript(
            `JSON.stringify({ barHidden: document.querySelector('#searchbar').hidden, marks: document.querySelectorAll('#edit-viewer mark.tot-search').length })`,
          ));
        }
        if (process.env.TOT_DRAG) {
          await new Promise((r) => setTimeout(r, 800));
          const drag = (x0, x1, y) => win.webContents.executeJavaScript(
            `{ const fire = (type, x, yy, target) => target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: yy, bubbles: true }));
              const r = document.querySelector('#sidebar-resizer');
              fire('pointerdown', ${x0}, ${y}, r);
              fire('pointermove', ${x1}, ${y}, document);
              fire('pointerup', ${x1}, ${y}, document); }`,
          );
          // drag1: 300 → 480
          await drag(300, 480, 300);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:drag1]', await win.webContents.executeJavaScript(
            `JSON.stringify({ sidebarWidth: document.querySelector('#sidebar').getBoundingClientRect().width })`,
          ));
          // drag2: 拖到 900 → clamp 600
          await drag(480, 900, 300);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:drag2]', await win.webContents.executeJavaScript(
            `JSON.stringify({ sidebarWidth: document.querySelector('#sidebar').getBoundingClientRect().width })`,
          ));
          // drag3: 拖到 0 → clamp 200
          await drag(600, 0, 300);
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:drag3]', await win.webContents.executeJavaScript(
            `JSON.stringify({ sidebarWidth: document.querySelector('#sidebar').getBoundingClientRect().width })`,
          ));
          // drag4: outline 高度下拉 80px
          await win.webContents.executeJavaScript(
            `{ window.__oh0 = document.querySelector('#outline-box').getBoundingClientRect().height;
              const fire = (type, yy, target) => target.dispatchEvent(new PointerEvent(type, { clientX: 100, clientY: yy, bubbles: true }));
              const r = document.querySelector('#outline-resizer');
              const sy = r.getBoundingClientRect().top;
              fire('pointerdown', sy, r);
              fire('pointermove', sy + 80, document);
              fire('pointerup', sy + 80, document); }`,
          );
          await new Promise((r) => setTimeout(r, 200));
          console.log('[dev:drag4]', await win.webContents.executeJavaScript(
            `JSON.stringify({ h0: window.__oh0, h1: document.querySelector('#outline-box').getBoundingClientRect().height })`,
          ));
        }
        if (process.env.TOT_SCREENSHOT) {
          await new Promise((r) => setTimeout(r, Number(process.env.TOT_WAIT) || 1500));
          // TOT_STYLE 指定时先切换到该风格再截（驱动侧兼容旧风格名）
          const styleId = { light: 'github-light', dark: 'github-dark' }[process.env.TOT_STYLE] || process.env.TOT_STYLE;
          if (styleId) {
            await win.webContents.executeJavaScript(
              `{ const sel = document.querySelector('#style-select'); sel.value = ${JSON.stringify(styleId)}; sel.dispatchEvent(new Event('change')); }`,
            );
            await new Promise((r) => setTimeout(r, 600));
          }
          const base = process.env.TOT_SCREENSHOT.replace(/\.png$/i, '');
          const shot1 = await win.webContents.capturePage();
          await fs.writeFile(`${base}.png`, shot1.toPNG());
          console.log(`[dev] screenshot saved: ${base}.png`);
          await win.webContents.executeJavaScript(
            `(document.querySelector('#viewer .callout') || document.querySelectorAll('#viewer h3')[1])?.scrollIntoView({ block: 'center' })`,
          );
          await new Promise((r) => setTimeout(r, 900));
          const shot2 = await win.webContents.capturePage();
          await fs.writeFile(`${base}-scrolled.png`, shot2.toPNG());
          console.log(`[dev] screenshot saved: ${base}-scrolled.png`);
        }
    } catch (err) {
      console.error('[dev] auto-drive failed:', err);
    }
    if (process.env.TOT_SCREENSHOT || process.env.TOT_CHECK) app.quit();
  });
}

app.whenReady().then(() => {
  protocol.handle('mdfile', handleMdfile);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
