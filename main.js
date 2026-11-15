/*
 * obsidian — Electron main process.
 *
 * The renderer is the web app's UI, bundled verbatim (see scripts/build-web.mjs).
 * This process owns everything the browser couldn't do privately:
 *   • the vault — a plain folder on the user's disk, chosen with native dialogs
 *   • the API   — fs-backed implementation of the web app's routes
 *                (src/main-api.cjs), reached only through contextIsolation +
 *                sandbox via preload.js
 *   • watching  — live updates when files change outside the app
 *   • deletes   — always to the Recycle Bin, never permanent
 *   • privacy   — strict CSP, zero network requests, external links ask first
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, Menu, session } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { createServerApi } = require('./src/main-api.cjs');

const APP_ROOT = __dirname;

app.setName('Basalt');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

let win = null;
/** every open obsidian window (main + note windows) */
const windows = new Set();

function samePath(a, b) {
  const ra = path.resolve(String(a || ''));
  const rb = path.resolve(String(b || ''));
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function isInsideRoot(root, abs) {
  const resRoot = path.resolve(root);
  const resAbs = path.resolve(abs);
  const cmpRoot = process.platform === 'win32' ? resRoot.toLowerCase() : resRoot;
  const cmpAbs = process.platform === 'win32' ? resAbs.toLowerCase() : resAbs;
  const prefix = cmpRoot.endsWith(path.sep) ? cmpRoot : cmpRoot + path.sep;
  return cmpAbs === cmpRoot || cmpAbs.startsWith(prefix);
}

function resolveExistingRealpath(target) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
  } catch {
    return null;
  }
}

function resolveRealpathOrAncestor(target) {
  const direct = resolveExistingRealpath(target);
  if (direct) return direct;
  let cur = path.resolve(target);
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    const realParent = resolveExistingRealpath(parent);
    if (realParent) {
      return path.join(realParent, path.relative(parent, target));
    }
    cur = parent;
  }
}

function getAliveWin(sender) {
  const fromSender = sender ? BrowserWindow.fromWebContents(sender) : null;
  if (fromSender && !fromSender.isDestroyed()) return fromSender;
  if (win && !win.isDestroyed()) return win;
  for (const w of windows) {
    if (!w.isDestroyed()) return w;
  }
  return undefined;
}

function showMsgBox(sender, opts) {
  const parent = getAliveWin(sender);
  return parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
}

function showOpenDlg(sender, opts) {
  const parent = getAliveWin(sender);
  return parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts);
}

/* ── the fs-backed API (same surface as the web app's routes) ─────────────── */

function sanitizeFolderName(name) {
  let n = String(name || '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '');
  if (!n || n === '.' || n === '..') n = 'Vault';
  return n.slice(0, 150);
}

const server = createServerApi({
  configDir: app.getPath('userData'),
  createVaultFolder: async (name) => {
    // Two native paths, like obsidian's "Open folder as vault" / "Create new vault".
    const choice = await showMsgBox(null, {
      type: 'question',
      title: 'Basalt — vault location',
      message: `Where should the vault "${name}" live?`,
      detail:
        'Create a new folder for it anywhere on your PC, or open an existing folder of Markdown files ' +
        '(an obsidian vault works as-is — obsidian reads the same plain .md files).',
      buttons: [`Create "${name}"…`, 'Open existing folder…', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice.response === 2) return null;

    if (choice.response === 0) {
      const parent = await showOpenDlg(null, {
        title: `Choose a location for "${name}"`,
        message: `A folder named "${sanitizeFolderName(name)}" will be created inside the folder you pick.`,
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Create vault here',
      });
      if (parent.canceled || !parent.filePaths[0]) return null;
      const root = path.join(parent.filePaths[0], sanitizeFolderName(name));
      await fsp.mkdir(root, { recursive: true });
      return { root, name: sanitizeFolderName(name) };
    }

    const existing = await showOpenDlg(null, {
      title: 'Open folder as vault',
      message: 'Pick any folder — every .md file inside becomes a note. Nothing is copied or moved.',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open vault',
    });
    if (existing.canceled || !existing.filePaths[0]) return null;
    return { root: existing.filePaths[0], name: path.basename(existing.filePaths[0]) };
  },
  trash: (absPath) => shell.trashItem(absPath), // Recycle Bin — reversible
});

/* ── bootstrap ────────────────────────────────────────────────────────────── */

function bootstrap() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

  app.on('second-instance', () => {
    const target = getAliveWin();
    if (target) {
      if (target.isMinimized()) target.restore();
      target.focus();
    }
  });

  app.whenReady().then(async () => {
    protocol.handle('app', handleAppProtocol);
    applyCSP();
    createWindow();
    await syncWatchers();
  });

  app.on('window-all-closed', () => app.quit());
}

/* ── window ───────────────────────────────────────────────────────────────── */

function windowChromeOptions() {
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#b3b3b3', height: 40 },
      autoHideMenuBar: true,
    };
  }
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' };
  }
  return {};
}

function attachDevToolsShortcut(w) {
  w.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toUpperCase() === 'I'))) {
      w.webContents.toggleDevTools();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#1e1e1e',
    title: 'Basalt',
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    ...windowChromeOptions(),
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  windows.add(win);
  win.on('closed', () => {
    windows.delete(win);
    win = null;
  });
  if (process.platform === 'win32') {
    win.setMenuBarVisibility(false);
    Menu.setApplicationMenu(null);
  } else {
    win.setMenuBarVisibility(true);
    buildMenu();
  }
  attachDevToolsShortcut(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.loadURL('app://app/src/renderer/index.html');

  const mainWin = win;
  mainWin.on('close', (e) => {
    if (!mainWin._readyToClose) {
      e.preventDefault();
      setTimeout(() => {
        if (!mainWin.isDestroyed() && !mainWin._readyToClose) {
          mainWin._readyToClose = true;
          mainWin.close();
        }
      }, 1500);
      mainWin.webContents.send('app:prepare-close'); // renderer flushes autosaves
    }
  });
}

/* ── note windows ("Open in new window") ─────────────────────────────────── */

/** A real second obsidian window showing a single note, editable like the main
 *  workspace. Shares the same preload/IPC API and the same fs watcher
 *  broadcasts, so edits land in the same vault files. */
function createNoteWindow(noteId, subpath) {
  const q = new URLSearchParams({ win: 'note', note: noteId });
  if (subpath) q.set('sub', subpath);
  const initialTheme = win && !win.isDestroyed() && win._titlebarTheme === 'light' ? 'light' : 'dark';
  const chrome = windowChromeOptions();
  if (chrome.titleBarOverlay) {
    chrome.titleBarOverlay = { ...chrome.titleBarOverlay, symbolColor: initialTheme === 'light' ? '#444444' : '#b3b3b3' };
  }
  const w = new BrowserWindow({
    width: 800,
    height: 660,
    minWidth: 380,
    minHeight: 280,
    backgroundColor: initialTheme === 'light' ? '#ffffff' : '#1e1e1e',
    title: 'Basalt',
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    ...chrome,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  w._titlebarTheme = initialTheme;
  windows.add(w);
  w.on('closed', () => windows.delete(w));
  if (process.platform === 'win32') w.setMenuBarVisibility(false);
  attachDevToolsShortcut(w);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.loadURL(`app://app/src/renderer/index.html?${q.toString()}`);
  w.on('close', (e) => {
    if (!w._readyToClose) {
      e.preventDefault();
      setTimeout(() => {
        if (!w.isDestroyed() && !w._readyToClose) {
          w._readyToClose = true;
          w.close();
        }
      }, 1500);
      w.webContents.send('app:prepare-close'); // flush autosaves first
    }
  });
  return w;
}

ipcMain.handle('open-note-window', (_e, noteId, subpath) => {
  try {
    if (!noteId || typeof noteId !== 'string') return 'error';
    createNoteWindow(noteId, subpath ? String(subpath) : null);
    return 'opened';
  } catch {
    return 'error';
  }
});

ipcMain.on('app:ready-to-close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) {
    w._readyToClose = true;
    w.close();
  }
});

ipcMain.on('app:titlebar-theme', (e, theme) => {
  const normalized = theme === 'light' ? 'light' : 'dark';
  const bg = normalized === 'light' ? '#ffffff' : '#1e1e1e';
  const sym = normalized === 'light' ? '#444444' : '#b3b3b3';
  for (const w of windows) {
    if (w.isDestroyed() || w._titlebarTheme === normalized) continue;
    w._titlebarTheme = normalized;
    w.setBackgroundColor(bg);
    if (process.platform === 'win32' && typeof w.setTitleBarOverlay === 'function') {
      try {
        w.setTitleBarOverlay({ color: '#00000000', symbolColor: sym, height: 40 });
      } catch {}
    }
    if (w.webContents !== e.sender) {
      try {
        w.webContents.send('app:theme-sync', normalized);
      } catch {}
    }
  }
});

/* ── Export to PDF ("Export to PDF" — rendered offscreen, saved locally) ──── */

function sanitizeFileName(name) {
  let n = String(name || '').trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '');
  if (!n) n = 'Untitled';
  return n.slice(0, 120);
}

ipcMain.handle('export-pdf', async (e, vaultId, fileName, html) => {
  let printWin = null;
  let tmpHtml = null;
  try {
    if (typeof html !== 'string' || !html) return 'error';
    const root = path.resolve(String(vaultId || ''));
    const roots = await server.vaultRoots();
    const matchedRoot = roots.find((r) => samePath(r, root));
    if (!matchedRoot) return 'blocked';

    // default location: <vault>/Exports/<note name>.pdf (obsidian-like)
    const exportsDir = path.join(matchedRoot, 'Exports');
    await fsp.mkdir(exportsDir, { recursive: true });
    const defaultPath = path.join(exportsDir, `${sanitizeFileName(fileName)}.pdf`);
    const parentWin = getAliveWin(e.sender);
    const saveOpts = {
      title: 'Export to PDF',
      defaultPath,
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
      buttonLabel: 'Export',
    };
    const choice = parentWin
      ? await dialog.showSaveDialog(parentWin, saveOpts)
      : await dialog.showSaveDialog(saveOpts);
    if (choice.canceled || !choice.filePath) return 'canceled';

    // render the printable HTML offscreen with Chromium, then print to PDF
    tmpHtml = path.join(app.getPath('temp'), `obsidian-export-${crypto.randomUUID()}.html`);
    await fsp.writeFile(tmpHtml, html, 'utf8');
    printWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    printWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    printWin.webContents.on('will-navigate', (ev) => {
      if (!ev.url.startsWith('file://')) ev.preventDefault();
    });
    await printWin.loadFile(tmpHtml);
    // give data-URI images a moment to decode
    await new Promise((r) => setTimeout(r, 150));
    const pdf = await printWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.65, bottom: 0.65, left: 0.6, right: 0.6 },
    });
    await fsp.writeFile(choice.filePath, pdf);
    shell.showItemInFolder(choice.filePath);
    return path.relative(matchedRoot, choice.filePath) || choice.filePath;
  } catch (err) {
    console.error('export-pdf failed', err);
    return 'error';
  } finally {
    if (printWin && !printWin.isDestroyed()) printWin.destroy();
    if (tmpHtml) await fsp.unlink(tmpHtml).catch(() => undefined);
  }
});

/* ── CSP (zero network) ───────────────────────────────────────────────────── */

function cspString() {
  return [
    "default-src 'self' app:",
    "img-src 'self' app: data: blob:",
    "media-src 'self' app: data: blob:",
    "style-src 'self' app: 'unsafe-inline'",
    "font-src 'self' app: data:",
    "script-src 'self' app:",
    "connect-src 'self' app:",
    "object-src 'self' app:",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
function applyCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [cspString()] } });
  });
}

/* ── app:// protocol (bundled UI + vault files) ───────────────────────────── */

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/opus',
  '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.m4v': 'video/mp4', '.ogv': 'video/ogg',
  '.pdf': 'application/pdf',
};

function serveFile(root, urlPath, respond) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath);
  } catch {
    return respond(400, 'Bad request', 'text/plain');
  }
  if (clean.includes('\0')) return respond(400, 'Bad request', 'text/plain');
  const abs = path.resolve(root, '.' + path.sep + clean.replace(/^\/+/, ''));
  if (!isInsideRoot(root, abs)) {
    return respond(403, 'Forbidden', 'text/plain');
  }
  const realRoot = resolveExistingRealpath(root);
  const realAbs = resolveExistingRealpath(abs);
  if (!realRoot || !realAbs || !isInsideRoot(realRoot, realAbs)) {
    return respond(realAbs ? 403 : 404, realAbs ? 'Forbidden' : 'Not found', 'text/plain');
  }
  fs.readFile(realAbs, (err, data) => {
    if (err) return respond(404, 'Not found', 'text/plain');
    const mime = MIME[path.extname(realAbs).toLowerCase()] || 'application/octet-stream';
    respond(200, data, mime);
  });
}

/** Only these vault-file types may ever be served over app://vault/ — never
 *  html/js, so a hostile attachment can never execute in the app's origin. */
const VAULT_SERVE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'image/svg+xml', 'image/x-icon',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac', 'audio/aac', 'audio/opus',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska',
  'application/pdf', 'text/plain',
]);

/** app://vault/<encoded vault root>/<relative path> — vault attachments.
 *  The vault root must be registered; the file type must be in the safe set. */
async function serveVaultFile(pathname, respond) {
  let vaultRoots = [];
  try {
    vaultRoots = await server.vaultRoots();
  } catch {
    vaultRoots = [];
  }
  const rest = pathname.replace(/^\/+/, '');
  const slash = rest.indexOf('/');
  if (slash === -1) return respond(404, 'Not found', 'text/plain');
  let root;
  try {
    root = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return respond(400, 'Bad request', 'text/plain');
  }
  const registered = vaultRoots.find((r) => samePath(r, root));
  if (!registered) return respond(403, 'Forbidden', 'text/plain');
  return new Promise((resolve) => {
    serveFile(registered, rest.slice(slash + 1), (status, data, mime) => {
      if (status === 200 && !VAULT_SERVE_MIME.has(mime)) {
        return resolve(respond(403, 'Blocked file type', 'text/plain'));
      }
      resolve(respond(status, data, mime));
    });
  });
}

function handleAppProtocol(request) {
  const u = new URL(request.url);
  const { Readable } = require('stream');
  const respond = (status, data, mime) => {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    return new Response(Readable.from([body]), {
      status,
      headers: { 'Content-Type': mime, 'Content-Security-Policy': cspString() },
    });
  };
  if (u.host === 'vault') {
    return serveVaultFile(u.pathname, respond);
  }
  return new Promise((resolve) => {
    serveFile(APP_ROOT, u.pathname, (status, data, mime) => resolve(respond(status, data, mime)));
  });
}

/* ── vault file watching → renderer invalidation ──────────────────────────── */

const watchers = new Map(); // root → { watcher, timer, pending:Set<rel> }

async function syncWatchers() {
  let roots = [];
  try {
    roots = await server.vaultRoots();
  } catch {
    roots = [];
  }
  for (const root of roots) {
    if (![...watchers.keys()].some((k) => samePath(k, root))) startWatcher(root);
  }
  for (const root of [...watchers.keys()]) {
    if (!roots.some((r) => samePath(r, root))) stopWatcher(root);
  }
}

function startWatcher(root) {
  try {
    const state = { watcher: null, timer: null, pending: new Set() };
    state.watcher = fs.watch(root, { recursive: true }, (_evt, filename) => {
      if (!filename) return
      const rel = filename.split(path.sep).join('/')
      const segs = rel.split('/')
      const isMeta = segs[0] === '.obsidian' || segs[0] === '.obsidian'
      if (!isMeta && segs.some((seg) => seg.startsWith('.') || seg === 'node_modules')) return
      if (isMeta && segs[1] === 'snapshots') return
      state.pending.add(rel)
      clearTimeout(state.timer)
      state.timer = setTimeout(() => flushWatcher(root, state), 250)
    });
    watchers.set(root, state);
  } catch (err) {
    console.error('watcher failed for', root, err)
  }
}

function stopWatcher(root) {
  const state = watchers.get(root)
  if (state) {
    try { state.watcher.close() } catch {}
    clearTimeout(state.timer)
    watchers.delete(root)
  }
}

function flushWatcher(root, state) {
  const rels = [...state.pending]
  state.pending.clear()
  server.invalidate(root) // drop content caches — next API call re-reads disk
  const mdRels = rels.filter((r) => /\.(md|markdown)$/i.test(r) && !r.startsWith('.'))
  const noteId = mdRels.length === 1 ? mdRels[0] : undefined
  const onlyMeta = rels.length > 0 && rels.every((r) => r.startsWith('.obsidian/') || r.startsWith('.obsidian/'))
  const kinds = onlyMeta
    ? ['settings', 'bookmarks']
    : ['tree', 'index', 'graph', 'tags', 'backlinks', 'bookmarks', 'search', 'settings']
  for (const w of windows) {
    if (w.isDestroyed()) continue
    w.webContents.send('app-invalidate', {
      vaultId: root,
      noteId,
      noteIds: mdRels,
      kinds,
    })
  }
}

/* ── IPC ──────────────────────────────────────────────────────────────────── */

ipcMain.handle('api', async (_e, op, args, ctx) => {
  try {
    const data = await server.dispatch(op, args ?? [], ctx ?? {})
    if (op === 'createVault' || op === 'deleteVault') await syncWatchers()
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
});

async function resolveRegisteredVaultItem(vaultId, relPath) {
  const rawRel = String(relPath || '')
  if (rawRel.includes('\0')) return null
  const roots = await server.vaultRoots().catch(() => [])
  const matched = roots.find((r) => samePath(r, vaultId))
  if (!matched) return null
  const cleanRel = rawRel.replace(/\\/g, '/').replace(/^\/+/, '')
  const abs = path.resolve(matched, '.' + path.sep + cleanRel)
  if (!isInsideRoot(matched, abs)) return null
  const realRoot = resolveExistingRealpath(matched)
  const realAbs = resolveRealpathOrAncestor(abs)
  if (!realRoot || !realAbs || !isInsideRoot(realRoot, realAbs)) return null
  return realAbs
}

ipcMain.handle('reveal-item', async (_e, vaultId, relPath) => {
  try {
    const abs = await resolveRegisteredVaultItem(vaultId, relPath)
    if (!abs) return 'blocked'
    shell.showItemInFolder(abs);
    return 'revealed';
  } catch {
    return 'error';
  }
});

ipcMain.handle('open-path', async (_e, vaultId, relPath) => {
  try {
    const abs = await resolveRegisteredVaultItem(vaultId, relPath)
    if (!abs) return 'blocked'
    await shell.openPath(abs); // open with the OS default app
    return 'opened';
  } catch {
    return 'error';
  }
});

ipcMain.handle('open-external', async (e, url) => {
  if (!/^(?:https?:\/\/|mailto:)/i.test(String(url || ''))) return 'blocked'
  const r = await showMsgBox(e.sender, {
    type: 'question',
    buttons: ['Open in external app', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: /^mailto:/i.test(url) ? 'Open this email link in your default mail client?' : 'Open this link in your default web browser?',
    detail: url,
    noLink: true,
  });
  if (r.response !== 0) return 'cancelled'
  await shell.openExternal(url)
  return 'opened'
});

ipcMain.handle('reveal-vault', async () => {
  const roots = await server.vaultRoots()
  if (roots.length > 0) shell.openPath(roots[0])
});

/* ── native menu (accelerators chosen to not collide with in-app hotkeys) ─── */

function buildMenu() {
  // menu clicks go to the focused window when possible (note windows too)
  const send = (id) => {
    const focused = BrowserWindow.getFocusedWindow();
    const target = focused && windows.has(focused) ? focused : win;
    if (target && !target.isDestroyed()) target.webContents.send('menu', id);
  };
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'New note', accelerator: 'CmdOrCtrl+N', click: () => send('new-note') },
        { label: 'New canvas', click: () => send('new-canvas') },
        { type: 'separator' },
        { label: 'Export to PDF…', click: () => send('export-pdf') },
        { type: 'separator' },
        { label: 'Open vault…', click: () => send('open-vault') },
        { label: 'Reveal vault in File Explorer', click: () => revealVault() },
        { type: 'separator' },
        { label: 'Close tab', click: () => send('close-tab') },
        { role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' }, { type: 'separator' },
        { label: 'Find in note…', click: () => send('find') },
        { label: 'Search vault…', click: () => send('search') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Toggle reading view', click: () => send('toggle-reading') },
        { label: 'Graph view', click: () => send('open-graph') },
        { label: "Today's daily note", accelerator: 'CmdOrCtrl+Shift+D', click: () => send('daily-note') },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Toggle dark / light theme', click: () => send('toggle-theme') },
        { role: 'reload' }, { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'Privacy statement',
          click: () =>
            showMsgBox(null, {
              type: 'info',
              title: 'Basalt — privacy',
              message: 'Your notes never leave this computer.',
              detail:
                'obsidian makes zero network requests — no telemetry, no update pings, no cloud, no CDN fonts.\n\n' +
                'Your vault is a plain folder of Markdown files; obsidian only ever reads and writes those files ' +
                '(and its own small .obsidian folder inside the vault).\n\n' +
                'Deleted notes go to the Windows Recycle Bin. External links ask before opening a browser.',
              buttons: ['OK'],
            }),
        },
        {
          label: 'Keyboard shortcuts',
          click: () =>
            showMsgBox(null, {
              type: 'info',
              title: 'Basalt — shortcuts',
              message: 'Basalt shortcuts are built in',
              detail:
                'Ctrl+P  Command palette        Ctrl+O  Quick switcher\n' +
                'Ctrl+E  Toggle reading view    Ctrl+G  Graph view\n' +
                'Ctrl+F  Find in note           Ctrl+Shift+F  Search vault\n' +
                'Ctrl+N  New note               Ctrl+Shift+D  Today\'s daily note\n' +
                'Ctrl+W  Close tab              Ctrl+,  Settings\n' +
                'Alt+←/→  Navigate history      F2  Rename (file explorer)',
              buttons: ['OK'],
            }),
        },
        {
          label: 'About Basalt',
          click: () =>
            showMsgBox(null, {
              type: 'info',
              title: 'Basalt',
              message: 'Basalt — a local-first Markdown knowledge base',
              detail:
                'An obsidian-style note app that reads and writes plain .md files in a folder on your own disk.\n\n' +
                'Original, open implementation (MIT) — not affiliated with obsidian (Dynalist Inc.).\n\n' +
                `Version ${app.getVersion()} · Electron ${process.versions.electron}`,
              buttons: ['OK'],
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Open the (most recently registered) vault folder in Windows File Explorer
async function revealVault() {
  const roots = await server.vaultRoots()
  if (roots.length > 0) shell.openPath(roots[0])
}
