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
  currentFile: null, // 当前打开的文件绝对路径
  style: localStorage.getItem('tot-style') || 'light',
};

const $ = (sel) => document.querySelector(sel);
const contentEl = $('#content');

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

// ---------- 目录与文件树 ----------

$('#open-dir').addEventListener('click', openDirectory);

async function openDirectory() {
  const data = await window.tot.selectDirectory();
  if (!data) return;
  renderTree(data);
}

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

// ---------- 打开文件与渲染 ----------

async function openFile(filePath, linkEl) {
  const text = await window.tot.readFile(filePath);
  state.currentFile = filePath;

  const viewer = $('#viewer');
  viewer.innerHTML = marked.parse(text);
  await fixImages();
  assignHeadingIds();
  // 先让 viewer 可见再建 IntersectionObserver，否则初始交集回调算出来全不相交
  $('#empty').hidden = true;
  viewer.hidden = false;
  contentEl.scrollTop = 0;
  renderOutline();

  document.querySelectorAll('#file-tree a.active').forEach((a) => a.classList.remove('active'));
  linkEl.classList.add('active');
}

// md 内相对路径图片 → 以当前文件所在目录为基准解析为 mdfile:// URL
async function fixImages() {
  const imgs = [...$('#viewer').querySelectorAll('img')];
  const srcs = imgs.map((img) => img.getAttribute('src') || '');
  const resolved = await window.tot.resolveImages(state.currentFile, srcs);
  imgs.forEach((img, i) => { img.src = resolved[i]; });
}

// ---------- 大纲 ----------

// 中文友好的 slug：保留中日韩与字母数字，空白转连字符
function slugify(text) {
  const s = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
  return s || 'section';
}

function assignHeadingIds() {
  const counts = new Map();
  $('#viewer').querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    let id = slugify(h.textContent);
    const n = (counts.get(id) || 0) + 1;
    counts.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    h.id = id;
  });
}

function renderOutline() {
  const ul = $('#outline');
  ul.textContent = '';
  const headings = $('#viewer').querySelectorAll('h1,h2,h3,h4,h5,h6');
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
  }, { root: contentEl, threshold: 0 });
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
