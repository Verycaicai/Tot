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

const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs/promises');

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

// ---------- IPC ----------

ipcMain.handle('select-directory', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  rootDir = res.filePaths[0];
  return { root: rootDir, tree: await scanDir(rootDir) };
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

// ---------- 窗口 ----------

function createWindow() {
  win = new BrowserWindow({
    title: 'Tot — Trail of Tears',
    icon: path.join(__dirname, 'Tot.png'),
    width: 1280,
    height: 840,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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

  // 仅开发/自动验证用：TOT_OPEN_DIR 启动即打开该目录（跳过对话框）；
  // TOT_OPEN_FILE 按文件名自动打开一个文件；TOT_SCREENSHOT 截两张图（顶部 + 滚动后）后退出；
  // TOT_CHECK 在页面里跑断言并打印 DOM 状态（树/渲染/大纲/scrollspy）后退出
  if (process.env.TOT_OPEN_DIR) {
    win.webContents.on('did-finish-load', async () => {
      try {
        const dir = process.env.TOT_OPEN_DIR;
        rootDir = path.resolve(dir);
        win.webContents.send('directory-selected', { root: rootDir, tree: await scanDir(rootDir) });
        if (process.env.TOT_OPEN_FILE) {
          await new Promise((r) => setTimeout(r, 400));
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('#file-tree a')].find((a) => a.textContent === ${JSON.stringify(process.env.TOT_OPEN_FILE)})?.click()`,
          );
        }
        if (process.env.TOT_CHECK) {
          await new Promise((r) => setTimeout(r, 800));
          const check = `JSON.stringify({
            treeFiles: [...document.querySelectorAll('#file-tree a')].map((a) => a.textContent),
            treeDirs: [...document.querySelectorAll('#file-tree summary')].map((s) => s.textContent),
            active: document.querySelector('#file-tree a.active')?.textContent ?? null,
            headings: [...document.querySelectorAll('#viewer h1,h2,h3,h4,h5,h6')].map((h) => h.id + ':' + h.tagName + ':' + h.textContent.slice(0, 12)),
            table: !!document.querySelector('#viewer table'),
            pre: !!document.querySelector('#viewer pre code'),
            imgSrc: document.querySelector('#viewer img')?.getAttribute('src') ?? null,
            imgLoaded: (() => { const i = document.querySelector('#viewer img'); return i ? i.naturalWidth > 0 : null; })(),
            outline: [...document.querySelectorAll('#outline a')].map((a) => a.getAttribute('href')),
            outlineActive: document.querySelector('#outline a.active')?.getAttribute('href') ?? null,
            style: document.body.className + '/' + (localStorage.getItem('tot-style') || 'none'),
          })`;
          console.log('[dev:check1]', await win.webContents.executeJavaScript(check));
          await win.webContents.executeJavaScript(
            `window.__scrollLog = []; document.querySelector('#content').addEventListener('scroll', () => window.__scrollLog.push(performance.now().toFixed(0) + ':' + document.querySelector('#content').scrollTop)); document.querySelectorAll('#viewer h3')[1]?.scrollIntoView({ block: 'start' });`,
          );
          await new Promise((r) => setTimeout(r, 700));
          console.log('[dev:check2]', await win.webContents.executeJavaScript(
            `JSON.stringify({
              scrollTop: document.querySelector('#content').scrollTop,
              active: document.querySelector('#outline a.active')?.getAttribute('href') ?? null,
              scrollLog: window.__scrollLog,
              headings: [...document.querySelectorAll('#viewer h1,h2,h3,h4,h5,h6')].map((h) => h.id + '@' + Math.round(h.getBoundingClientRect().top)),
            })`,
          ));
          if (process.env.TOT_STYLE) {
            console.log('[dev:check3]', await win.webContents.executeJavaScript(
              `new Promise((resolve) => {
                const sel = document.querySelector('#style-select');
                sel.value = ${JSON.stringify(process.env.TOT_STYLE)};
                sel.dispatchEvent(new Event('change'));
                setTimeout(() => {
                  const cs = getComputedStyle(document.querySelector('#viewer'));
                  resolve(JSON.stringify({
                    bodyClass: document.body.className,
                    ghHref: document.querySelector('#gh-style').getAttribute('href'),
                    ghDisabled: document.querySelector('#gh-style').disabled,
                    stored: localStorage.getItem('tot-style'),
                    viewerBg: cs.backgroundColor,
                    viewerColor: cs.color,
                  }));
                }, 400);
              })`,
            ));
          }
        }
        if (process.env.TOT_SCREENSHOT) {
          await new Promise((r) => setTimeout(r, Number(process.env.TOT_WAIT) || 1500));
          const base = process.env.TOT_SCREENSHOT.replace(/\.png$/i, '');
          const shot1 = await win.webContents.capturePage();
          await fs.writeFile(`${base}.png`, shot1.toPNG());
          console.log(`[dev] screenshot saved: ${base}.png`);
          await win.webContents.executeJavaScript(
            `document.querySelectorAll('#viewer h3')[1]?.scrollIntoView({ block: 'start' })`,
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
