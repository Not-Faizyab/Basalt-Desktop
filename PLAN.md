# obsidian — Plan & Architecture

> The design document for a Windows desktop app that reads folders of Markdown
> files from the local PC with maximum privacy, and functions like obsidian.
> Status: **v0.2.0 — the web edition's UI running natively on local folders.**

---

## Part I — Vision & principles

1. **Local-first.** The vault is a plain folder. Notes are plain `.md` files. No database, no service, no account. If obsidian disappears tomorrow, every note opens in Notepad, VS Code, obsidian, or anything else.
2. **Maximum privacy.** Zero network requests, ever. Strict CSP. External links ask before opening. Everything is auditable because everything ships as source.
3. **The web edition's UI, exactly.** v0.2 replaces the hand-rolled v0.1 UI with the web app's React UI, bundled verbatim. One codebase, one look, one behavior — the version users preferred.
4. **Functional parity with the core obsidian workflow** — vaults, live-preview editing, wikilinks, backlinks, graph, palette, switcher, splits, search, tags, outline, daily notes, callouts — implemented as original code.

Non-goals: cloud sync, accounts, telemetry, mobile.

## Part II — v0.2 architecture

```
┌────────────────────────────── Electron ──────────────────────────────┐
│ main.js (Node)                         preload.js (contextIsolation) │
│  • window, native menus, dialogs       • window.desktop.invoke(op,…) │
│  • app:// protocol + strict CSP        • invalidate/menu/close events│
│  • vault registry (userData JSON)                                     │
│  • fs.watch per vault → invalidation        ┌────────────────────────┤
│  • src/main-api.cjs — the fs-backed API    │  renderer (Chromium)   │
│    listVaults / tree / index / graph /     │  the web edition UI,   │
│    tags / search / note CRUD / folders /   │  prebuilt (esbuild +   │
│    bookmarks / settings                    │  Tailwind, from src/   │
│  • deletes → shell.trashItem               │  obsidian/**)          │
│  • link rewriting on rename/move           │  api.ts → IPC shim     │
└────────────────────────────────────────────┴────────────────────────┘
```

**The key contract** — the web app was built against a fetch-based API client
(`src/obsidian/api.ts`). The desktop build swaps exactly that one module for an
IPC shim (`src/obsidian-desktop/api-ipc.ts`) with identical signatures, and
implements the same 22 operations against the file system
(`src/obsidian-desktop/server-api.ts` → bundled to `src/main-api.cjs`).

**IDs are paths.** Vault id = absolute folder path; note id = vault-relative
file path (`Projects/Ideas.md`); folder id = relative dir path. Stable across
restarts, and every id is literally a file.

**Web semantics, desktop upgrades** — unique-name guards, 409-style clash
errors, the search grammar (`tag:`/`path:`/`file:`/`task-todo:`/`OR`/negation),
graph/backlink computation: all identical to the web routes (shared logic in
`src/lib/obsidian/*`). Two behaviors match obsidian rather than the web DB:
renames/moves rewrite `[[links]]` across the vault, and deletes go to the
Recycle Bin.

**State** — vault registry + global settings: `userData/` (JSON). Bookmarks:
`.obsidian/bookmarks.json` inside each vault. Workspace layout, last vault,
per-vault UI state: `localStorage` (Electron partition), exactly where the web
app already kept it.

## Part III — Feature matrix (v0.2.0 = web UI + fs layer)

| Feature | Status | Notes |
| --- | --- | --- |
| Vault open (any folder) / create / switch / remove | ✅ | Native dialogs; removing never touches files |
| File explorer | ✅ | Tree, new/rename/delete, drag-to-move, context menus |
| Live preview editing | ✅ | Web edition's block editor |
| Source mode + reading view | ✅ | `Ctrl+E` per tab |
| Wikilinks + autocomplete, aliases, heading links | ✅ | `[[` suggest; unresolved → create |
| Embeds `![[Note]]`, `![[Note#Section]]` | ✅ | Note embeds |
| Backlinks + unlinked mentions | ✅ | With context snippets |
| Outgoing links / outline / tags panes | ✅ | Right sidebar |
| Graph view + local graph | ✅ | Groups, filters, arrows, force sliders |
| Command palette / quick switcher | ✅ | Fuzzy; switcher creates on Enter |
| Vault search | ✅ | Full web grammar, case toggle |
| Daily notes + templates | ✅ | `{{date}} {{time}} {{title}}` tokens |
| Bookmarks pane | ✅ | Per-vault, in `.obsidian/` |
| Properties (YAML frontmatter) panel | ✅ | Typed values |
| Callouts, task lists, highlights, tables | ✅ | |
| Page preview (hover) | ✅ | `[[link]]` hover popups |
| Note composer (extract block → new note) | ✅ | |
| Tabs + split panes + history | ✅ | Workspace persisted per vault |
| Themes, accent color, font size | ✅ | Dark / Moonstone |
| Core-plugin toggles, hotkeys list, settings modal | ✅ | |
| Rename/move rewrites links | ✅ | Wikilinks + md links, shortest-path rebuild |
| Recycle-Bin deletes | ✅ | `shell.trashItem` |
| File watching + external-edit reload | ✅ | Clean docs hot-reload; dirty docs kept |
| Attachments/images in tree & paste-to-vault | ⬜ roadmap | Web UI has no attachment handling yet |
| Math (KaTeX) | ⬜ roadmap | Web UI renders code via Prism, not math |
| Slash commands, spellcheck suggestions | ⬜ roadmap | |
| Hotkey remapping | ⬜ roadmap | Hotkeys are listed, not editable, in the web UI |
| Canvas, plugin API, PDF/audio embeds, multi-window | ⬜ roadmap | See Part V |

## Part IV — Privacy engineering

1. **CSP** `default-src 'self' app:` — no remote script/style/font/img/media; `connect-src 'self' app:`; `frame-src 'none'`.
2. **No network code paths** — the app makes zero fetch/XHR; the renderer talks only IPC. Fonts (Inter variable) are bundled.
3. **External links** — `will-navigate` blocked; clicks on http(s) go through a confirm dialog → `shell.openExternal`.
4. **Deletes** — always `shell.trashItem`.
5. **Sandboxed renderer** — `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; preload exposes one auditable object.
6. **Path safety** — all vault-relative ids are normalized and containment-checked before touching disk.

## Part V — Roadmap

1. **Attachments** — images in the file tree, `![[image.png]]` embeds, paste-to-vault, configurable attachment folder.
2. **Math** — KaTeX in both views (`$…$`, `$$…$$`).
3. **Canvas** — the `.canvas` JSON whiteboard format (read + interactive edit).
4. **Plugin API** — sandboxed iframes + postMessage bridge, manifest format, settings contribution.
5. **Hotkey remapping** — capture-and-set editor behind the existing list.
6. **Sync-friendly touches** — merge prompt on external change of a dirty doc; `.md` conflict copies.
7. **Multi-window / tabs-to-window drag**.
8. **PDF & audio embeds**.

## Part VI — History

- **v0.1.0** — hand-rolled vanilla UI (CodeMirror 6), full fs/watcher/privacy layer. Superseded; preserved under `src/legacy-v0.1/`.
- **v0.2.0** — the web edition's React UI, bundled verbatim via `scripts/build-web.mjs`, on the same privacy layer. The web app's fetch client is swapped for an IPC shim; the 22-route API surface is implemented against real folders with identical semantics plus obsidian-style link rewriting and Recycle-Bin deletes.
