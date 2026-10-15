'use strict';

// ---------- marked 配置：转义原始 HTML，防本地 md 内嵌脚本 ----------

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

marked.use({
  renderer: {
    html(token) {
      return escapeHtml(typeof token === 'string' ? token : token.text);
    },
  },
});

// ---------- 状态 ----------

const state = {
  root: null,        // 当前根目录
  style: localStorage.getItem('tot-style') || 'light',
};

// 标签页：{ id, path, name, text, dirty, mode:'preview'|'edit', lineEnding, scrollTop }
const tabs = [];
let activeTab = null;
let openSeq = 0;      // 打开序号：防慢 readFile 晚到覆盖当前标签页

const $ = (sel) => document.querySelector(sel);

// 当前活动的渲染区与滚动容器（预览 #viewer / 编辑右栏 #edit-viewer）
function activeViewer() {
  return activeTab && activeTab.mode === 'edit' ? $('#edit-viewer') : $('#viewer');
}

function activeScroll() {
  return activeTab && activeTab.mode === 'edit' ? $('#edit-viewer') : $('#preview-scroll');
}

// ---------- 风格切换 ----------

const GH_STYLES = { light: '../lib/github-markdown-light.css', dark: '../lib/github-markdown-dark.css' };

function applyStyle() {
  document.body.className = `style-${state.style}`;
  $('#style-select').value = state.style;
  // 亮/暗用 vendored 的 github-markdown-css（link 换文件）；极简卸载它、只用手写 minimal.css
  const link = $('#gh-style');
  if (state.style === 'minimal') link.disabled = true;
  else {
    link.disabled = false;
    link.href = GH_STYLES[state.style];
  }
  localStorage.setItem('tot-style', state.style);
}

$('#style-select').addEventListener('change', (e) => {
  state.style = e.target.value;
  applyStyle();
});
applyStyle();

// ---------- 菜单命令（主进程 File 菜单触发） ----------

window.tot.onMenuCommand((cmd) => {
  if (cmd === 'open-folder') openDirectory();
  else if (cmd === 'open-file') openSingleFile();
  else if (cmd === 'save') saveActiveTab();
});

async function openDirectory() {
  const data = await window.tot.selectDirectory();
  if (!data) return;
  renderTree(data);
}

// 菜单 文件 → 打开文件：以文件所在目录为根渲染树，并打开该文件
async function openSingleFile() {
  const data = await window.tot.selectFile();
  if (!data) return;
  renderTree(data);
  openFile(data.file);
}

// ---------- 目录与文件树 ----------

// 开发模式（TOT_OPEN_DIR）下主进程直接推送目录数据
window.tot.onDirectorySelected(renderTree);

function renderTree(data) {
  state.root = data.root;
  const treeEl = $('#file-tree');
  treeEl.textContent = '';
  if (!data.tree.length) {
    const p = document.createElement('p');
    p.className = 'tree-empty';
    p.textContent = '没有找到 Markdown 文件';
    treeEl.append(p);
  } else {
    treeEl.append(buildTree(data.tree));
  }
  restoreTreeActive();
}

function buildTree(entries) {
  const ul = document.createElement('ul');
  for (const entry of entries) {
    const li = document.createElement('li');
    if (entry.type === 'dir') {
      const details = document.createElement('details');
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = entry.name;
      details.append(summary, buildTree(entry.children));
      li.append(details);
    } else {
      const a = document.createElement('a');
      a.textContent = entry.name;
      a.href = '#';
      a.title = entry.path;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openFile(entry.path, a);
      });
      li.append(a);
    }
    ul.append(li);
  }
  return ul;
}

// ---------- 标签页 ----------

function baseName(p) {
  return p.split(/[\\/]/).pop();
}

// 打开文件：已开则激活，否则新建标签页并渲染
async function openFile(filePath, linkEl) {
  const existing = tabs.find((t) => t.path === filePath);
  if (existing) {
    await activateTab(existing);
  } else {
    const seq = ++openSeq;
    const text = await window.tot.readFile(filePath);
    if (seq !== openSeq) return; // 已有更新的打开请求，丢弃本次
    const tab = {
      id: `tab-${seq}`,
      path: filePath,
      name: baseName(filePath),
      text,
      dirty: false,
      mode: 'preview',
      lineEnding: text.includes('\r\n') ? '\r\n' : '\n',
      scrollTop: 0,
    };
    tabs.push(tab);
    await renderTab(tab);
  }
  if (linkEl) {
    document.querySelectorAll('#file-tree a.active').forEach((a) => a.classList.remove('active'));
    linkEl.classList.add('active');
  }
}

// 新开标签页：渲染到预览区
async function renderTab(tab) {
  activeTab = tab;
  $('#panes').hidden = false;
  $('#empty').hidden = true;
  showPanes('preview');
  await renderMarkdown($('#viewer'), tab.text, tab.path);
  rebuildOutline();
  activeScroll().scrollTop = 0;
  updateTabbar();
  restoreTreeActive();
}

// 切换标签页：互存滚动位置，重渲染并恢复（含编辑/预览模式）
async function activateTab(tab) {
  if (tab === activeTab) return;
  if (activeTab) activeTab.scrollTop = activeScroll().scrollTop;
  activeTab = tab;
  $('#panes').hidden = false;
  $('#empty').hidden = true;
  showPanes(tab.mode);
  if (tab.mode === 'edit') {
    $('#editor').value = tab.text;
    await renderMarkdown($('#edit-viewer'), tab.text, tab.path);
  } else {
    await renderMarkdown($('#viewer'), tab.text, tab.path);
  }
  rebuildOutline();
  activeScroll().scrollTop = tab.scrollTop;
  updateTabbar();
  restoreTreeActive();
}

function updateTabbar() {
  const bar = $('#tabbar');
  bar.textContent = '';
  bar.hidden = tabs.length === 0;
  $('#edit-toggle').disabled = !activeTab;
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t === activeTab ? ' active' : '');
    t.el = el; // dirty 更新只改节点类，不重建整条 tab 栏
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name;
    const dirty = document.createElement('span');
    dirty.className = 'tab-dirty';
    dirty.textContent = '●';
    dirty.hidden = !t.dirty;
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = '关闭';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(t);
    });
    el.append(name, dirty, close);
    el.addEventListener('click', () => { activateTab(t); });
    bar.append(el);
  }
}

function restoreTreeActive() {
  document.querySelectorAll('#file-tree a.active').forEach((a) => a.classList.remove('active'));
  if (!activeTab) return;
  const link = document.querySelector(`#file-tree a[title="${CSS.escape(activeTab.path)}"]`);
  if (link) link.classList.add('active');
}

// ---------- 关闭标签页（dirty 时先确认） ----------

let pendingCloseIndex = -1;

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  if (tab.dirty) {
    pendingCloseIndex = i;
    $('#close-confirm').hidden = false;
    return;
  }
  doClose(i);
}

function doClose(i) {
  pendingCloseIndex = -1;
  $('#close-confirm').hidden = true;
  const wasActive = tabs[i] === activeTab;
  tabs.splice(i, 1);
  if (!tabs.length) {
    activeTab = null;
    $('#panes').hidden = true;
    $('#empty').hidden = false;
    $('#edit-toggle').disabled = true;
    $('#outline-box').hidden = true;
    $('#outline').textContent = '';
    restoreTreeActive();
    updateTabbar();
    return;
  }
  if (wasActive) activateTab(tabs[Math.min(i, tabs.length - 1)]);
  else updateTabbar();
}

$('#close-discard').addEventListener('click', () => { if (pendingCloseIndex >= 0) doClose(pendingCloseIndex); });
$('#close-cancel').addEventListener('click', () => { pendingCloseIndex = -1; $('#close-confirm').hidden = true; });

// ---------- 编辑（双栏实时预览） ----------

let editTimer = null; // 输入 debounce

// 显示预览/编辑面板并同步按钮文案
function showPanes(mode) {
  $('#preview-scroll').hidden = mode === 'edit';
  $('#edit-pane').hidden = mode !== 'edit';
  $('#edit-toggle').textContent = mode === 'edit' ? '预览' : '编辑';
}

$('#edit-toggle').addEventListener('click', async () => {
  if (!activeTab) return;
  await setMode(activeTab.mode === 'edit' ? 'preview' : 'edit');
});

// 切换当前标签页的预览/编辑模式（互存滚动位置）
async function setMode(mode) {
  if (!activeTab || activeTab.mode === mode) return;
  activeTab.scrollTop = activeScroll().scrollTop;
  activeTab.mode = mode;
  showPanes(mode);
  clearTimeout(editTimer);
  if (mode === 'edit') {
    $('#editor').value = activeTab.text;
    await renderMarkdown($('#edit-viewer'), activeTab.text, activeTab.path);
  } else {
    await renderMarkdown($('#viewer'), activeTab.text, activeTab.path);
  }
  rebuildOutline();
  activeScroll().scrollTop = activeTab.scrollTop;
}

// 编辑器输入：文本与 dirty 即时同步，300ms debounce 刷新右栏
$('#editor').addEventListener('input', (e) => {
  if (!activeTab || activeTab.mode !== 'edit') return;
  activeTab.text = e.target.value;
  activeTab.dirty = true;
  updateTabbarDirty(activeTab);
  clearTimeout(editTimer);
  editTimer = setTimeout(async () => {
    if (!activeTab || activeTab.mode !== 'edit') return; // 期间切走则丢弃
    await renderMarkdown($('#edit-viewer'), activeTab.text, activeTab.path);
    rebuildOutline();
  }, 300);
});

function updateTabbarDirty(tab) {
  if (tab.el) tab.el.querySelector('.tab-dirty').hidden = !tab.dirty;
}

// 菜单 文件 → 保存 / Ctrl+S（唯一入口，渲染层不监听 Ctrl+S 防双触发）
async function saveActiveTab() {
  if (!activeTab || !activeTab.dirty) return;
  const tab = activeTab;
  if (tab.mode === 'edit') {
    tab.text = $('#editor').value;
    await renderMarkdown($('#edit-viewer'), tab.text, tab.path);
    rebuildOutline();
  }
  try {
    // 编辑器把换行统一成 \n，写盘时按原文件的换行风格还原
    await window.tot.writeFile(tab.path, tab.text.split('\n').join(tab.lineEnding));
    tab.dirty = false;
    updateTabbarDirty(tab);
    showStatus('已保存');
  } catch (err) {
    showStatus('保存失败：' + err.message, true);
  }
}

let statusTimer = null;

function showStatus(msg, isError) {
  const el = $('#save-status');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}

// ---------- 渲染 ----------

// 把 md 文本渲染进目标容器：marked 解析 + 图片相对路径解析 + 标题 id
async function renderMarkdown(targetEl, text, filePath) {
  targetEl.innerHTML = marked.parse(text);
  const imgs = [...targetEl.querySelectorAll('img')];
  const srcs = imgs.map((img) => img.getAttribute('src') || '');
  const resolved = await window.tot.resolveImages(filePath, srcs);
  imgs.forEach((img, i) => { img.src = resolved[i]; });
  assignHeadingIds(targetEl);
}

// ---------- 大纲 ----------

// 中文友好的 slug：保留中日韩与字母数字，空白转连字符
function slugify(text) {
  const s = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
  return s || 'section';
}

function assignHeadingIds(targetEl) {
  const counts = new Map();
  targetEl.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    let id = slugify(h.textContent);
    const n = (counts.get(id) || 0) + 1;
    counts.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    h.id = id;
  });
}

function rebuildOutline() {
  const viewer = activeViewer();
  const ul = $('#outline');
  ul.textContent = '';
  const headings = viewer.querySelectorAll('h1,h2,h3,h4,h5,h6');
  $('#outline-box').hidden = headings.length === 0;
  headings.forEach((h) => {
    const li = document.createElement('li');
    li.className = `level-${h.tagName[1]}`;
    const a = document.createElement('a');
    a.textContent = h.textContent;
    a.href = `#${h.id}`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.append(a);
    ul.append(li);
  });
  setupScrollspy(headings);
}

// ---------- scrollspy：视口内最靠上的标题在大纲中高亮 ----------

let observer = null;

function setupScrollspy(headings) {
  if (observer) observer.disconnect();
  // IO 回调只带「状态发生变化」的标题，所以维护一张持续更新的可见性表，
  // 每次从当前全部可见的标题里选视口内最靠上的
  const visibility = new Map();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) visibility.set(e.target, e.isIntersecting);
    let best = null;
    let bestTop = Infinity;
    for (const [el, visible] of visibility) {
      if (!visible) continue;
      const top = el.getBoundingClientRect().top;
      if (top < bestTop) {
        bestTop = top;
        best = el;
      }
    }
    if (best) setActiveHeading(best);
  }, { root: activeScroll(), threshold: 0 });
  headings.forEach((h) => observer.observe(h));
}

function setActiveHeading(heading) {
  document.querySelectorAll('#outline a.active').forEach((a) => a.classList.remove('active'));
  const link = document.querySelector(`#outline a[href="#${heading.id}"]`);
  if (link) {
    link.classList.add('active');
    // 大纲区自身可滚动，保证高亮项可见
    link.closest('li').scrollIntoView({ block: 'nearest' });
  }
}
