# Basalt Desktop 🌑

[![Electron 33](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%20x64-blue?logo=windows)](https://microsoft.com/windows)
[![Local First](https://img.shields.io/badge/Storage-Local%20Plain%20.md-success)](#)
[![Zero Telemetry](https://img.shields.io/badge/Network-Zero%20Telemetry-brightgreen)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Basalt Desktop** is a blazing-fast, 100% offline personal knowledge base built for Windows. It runs directly on top of ordinary folders of plain `.md` files on your hard drive. Point it at any folder—including your existing Obsidian vaults—and immediately enjoy linked notes, full-text search, an interactive graph view, and infinite canvas boards with **zero telemetry, zero network tracking, and complete privacy**.

---

## 🔒 Core Philosophy

1. **Your Data is Yours Forever**: Your vault is just a regular folder on your PC. Notes are plain `.md` text files. If Basalt disappears tomorrow, all your notes open cleanly in Notepad, VS Code, Obsidian, or Git.
2. **True Byte-for-Byte Preservation**: Basalt respects your files. Code blocks with blank lines, Windows CRLF line endings, trailing newlines, and block IDs (`^block-id`) are preserved down to the exact byte.
3. **Absolute Privacy & Zero Network**: No accounts, no cloud sync lock-in, and zero background analytics. Strict Content Security Policy (CSP) enforces local-only execution.
4. **Native Desktop Polish**: Frameless custom titlebars, window snapping, multi-window support, and native Windows Recycle Bin integration.

---

## ✨ Features

### 📝 Obsidian-Style Writing Flow
- **Continuous Page Editor**: Write without distraction. No artificial block barriers, no cursor jumping, and no disappearing blank lines when you click away.
- **Smart Lists**: Automatic bullet/numbered list continuation on `Enter`, and clean exit on empty markers.
- **Live Preview & Source Mode**: Switch between visual typography (`Ctrl+E`), raw markdown source, and read-only preview.
- **Full Right-Click Context Menus**: Obsidian-exact text and navigation menus with hotkey indicators, formatting submenus, and link actions.
- **YAML Frontmatter & Properties**: Visual properties manager that reads and writes clean YAML at the top of your markdown files.

### 📂 Vaults & Filesystem Integration
- **Direct Disk Access**: Reads and writes directly to local storage via high-performance Node.js filesystem APIs.
- **Live File Watching**: Edit files externally in VS Code or sync them via Syncthing/Git—Basalt updates automatically.
- **Recycle Bin Protection**: Deleting a file or folder safely moves it to the **Windows Recycle Bin**—no accidental data loss.
- **Link Auto-Refactoring**: Renaming a note or moving a folder automatically updates all `[[wikilinks]]` throughout your entire vault.

### 🌐 Graph View & Infinite Canvas
- **Force-Directed Graph (`Ctrl+G`)**: Visualize connections between your notes with neighborhood highlighting, tag filtering, node sizing, and physics controls.
- **Infinite Spatial Canvas (`.canvas`)**: JSON Canvas compatible boards. Place markdown cards, connect notes, color-code ideas, and organize with keyboard shortcuts (`Ctrl+C`, `Ctrl+V`, `Ctrl+D`).

### ⚡ Navigation & Workspace
- **Multi-Window Support**: Open any note in a separate native window with full live-sync editing.
- **Split Panes**: Split editors vertically or horizontally with drag-resizable panes.
- **Command Palette (`Ctrl+P`) & Quick Switcher (`Ctrl+O`)**: Instantly jump to notes, trigger actions, or create new files.
- **Vault-Wide Search (`Ctrl+Shift+F`)**: Instant search supporting `tag:`, `path:`, `file:`, `task-todo:`, `task-done:`, `-negation`, and `OR`.
- **Daily Notes & Templates (`Ctrl+Shift+D`)**: Auto-create daily journals with `{{date}}`, `{{time}}`, and `{{title}}` tokens.
- **File Recovery**: Built-in snapshot browser to inspect and restore past note versions.
- **Export to PDF**: Clean, offline document export directly to disk.

---

## 📥 Downloads

Pre-built Windows binaries are generated in the `release/` directory:

| Package | Format | Description |
| --- | --- | --- |
| **Basalt Setup** | `.exe` (NSIS) | Full Windows installer with desktop and Start menu shortcuts |
| **Basalt Portable** | `.exe` | Standalone portable executable (run anywhere without installation) |

---

## 🛠️ Building & Running

### Quick Start (Run Electron App)
```bash
npm start
```

### Running the Demo Vault in Browser
```bash
npm run serve:demo
```

### Packaging Windows Installer & Portable `.exe`
```bash
npm run dist
```
*The packaged binaries will be output to the `release/` folder.*

---

## ⌨️ Default Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl + P` | Open Command Palette |
| `Ctrl + O` | Open Quick Switcher |
| `Ctrl + N` | Create New Note |
| `Ctrl + T` | Open New Tab |
| `Ctrl + W` | Close Tab |
| `Ctrl + E` | Toggle Reading / Live Preview View |
| `Ctrl + G` | Open Graph View |
| `Ctrl + Shift + D` | Open Today's Daily Note |
| `Ctrl + Shift + F` | Search Across Entire Vault |
| `Ctrl + F` / `Ctrl + H` | Find / Replace in Active Note |
| `Ctrl + B` / `Ctrl + I` | Bold / Italic Selection |
| `Ctrl + ,` | Open Settings |
| `Alt + ←` / `Alt + →` | Navigate Tab History Back / Forward |

---

## 🏗️ Architecture & Security

```
┌────────────────────────────── Electron Shell ──────────────────────────────┐
│ main.js (Node.js runtime)              preload.js (Context Isolation)      │
│  • Frameless Window & Native Titlebar   • window.desktop IPC bridge        │
│  • Chokidar File Watcher & Dialogs      • Secure event dispatching         │
│  • app:// Custom Protocol & Strict CSP                                     │
├────────────────────────────────────────────────────────────────────────────┤
│ src/main-api.cjs                        src/renderer/                      │
│  • Direct Disk I/O & .md Serialization  • Prebundled React UI              │
│  • Link Rewriting & Vault Indexing      • Live Preview, Canvas, Graph View │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Context Isolation & Sandbox**: Renderer has zero direct Node.js access; communication occurs solely through a strictly validated `window.desktop` IPC bridge.
- **Strict CSP**: `default-src 'self' app:` prevents remote script injection or accidental network leaks.
- **Local Protocol**: Packaged app loads local assets through an optimized `app://` protocol.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

*Disclaimer: Basalt is an independent open-source project inspired by the Obsidian workflow. It is not affiliated with, endorsed by, or derived from Obsidian (Dynalist Inc.).*
