/*
 * obsidian preload — the only bridge between the web UI and the main process.
 * contextIsolation + sandbox: the page gets exactly one object, window.desktop,
 * with an explicit, auditable surface.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  /** Run one API operation — same surface as the web app's fetch client. */
  invoke: (op, args, ctx) => ipcRenderer.invoke('api', op, args, ctx),
  /** External http(s) link → confirmation dialog in the main process. */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  /** Show a vault file in the OS file manager (selects the file). */
  revealItem: (vaultId, relPath) => ipcRenderer.invoke('reveal-item', vaultId, relPath),
  /** Open a vault file with the OS default application. */
  openPath: (vaultId, relPath) => ipcRenderer.invoke('open-path', vaultId, relPath),
  /** Open one note in its own obsidian window ("Open in new window"). */
  openNoteWindow: (noteId, subpath) => ipcRenderer.invoke('open-note-window', noteId, subpath),
  /** Render printable HTML to a PDF saved inside the vault's Exports folder. */
  exportPdf: (vaultId, fileName, html) => ipcRenderer.invoke('export-pdf', vaultId, fileName, html),
  /** Vault files changed on disk → refresh queries / hot-reload clean docs. */
  onInvalidate: (cb) => {
    const h = (_e, detail) => cb(detail);
    ipcRenderer.on('app-invalidate', h);
    return () => ipcRenderer.removeListener('app-invalidate', h);
  },
  /** Native menu click → run an in-app command. */
  onMenu: (cb) => {
    const h = (_e, id) => cb(id);
    ipcRenderer.on('menu', h);
    return () => ipcRenderer.removeListener('menu', h);
  },
  /** Window is closing → flush autosaves, then call readyToClose(). */
  onPrepareClose: (cb) => {
    const h = () => cb();
    ipcRenderer.on('app:prepare-close', h);
    return () => ipcRenderer.removeListener('app:prepare-close', h);
  },
  /** Sync dark/light theme changes pushed by main process across open windows. */
  onThemeSync: (cb) => {
    const h = (_e, theme) => cb(theme);
    ipcRenderer.on('app:theme-sync', h);
    return () => ipcRenderer.removeListener('app:theme-sync', h);
  },
  readyToClose: () => ipcRenderer.send('app:ready-to-close'),
  setTitleBarTheme: (theme) => ipcRenderer.send('app:titlebar-theme', theme),
  platform: process.platform,
});
