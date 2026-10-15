'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tot', {
  // 打开目录对话框，返回 { root, tree } 或 null（取消）
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  // 打开单个 md 文件（菜单 文件 → 打开文件），返回 { root, tree, file } 或 null
  selectFile: () => ipcRenderer.invoke('select-file'),
  // 读取所选目录内文件的文本内容
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  // 保存当前编辑内容（菜单 文件 → 保存 / Ctrl+S）
  writeFile: (filePath, text) => ipcRenderer.invoke('write-file', filePath, text),
  // 批量把 md 内图片相对路径解析为 mdfile:// URL
  resolveImages: (filePath, srcs) => ipcRenderer.invoke('resolve-images', filePath, srcs),
  // 主进程主动推送目录（开发模式 TOT_OPEN_DIR 用）
  onDirectorySelected: (cb) => ipcRenderer.on('directory-selected', (_e, data) => cb(data)),
  // 主进程菜单命令（open-file / open-folder / save）
  onMenuCommand: (cb) => ipcRenderer.on('menu-command', (_e, cmd) => cb(cmd)),
});
