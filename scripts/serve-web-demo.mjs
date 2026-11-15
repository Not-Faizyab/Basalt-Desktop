/*
 * serve-web-demo.mjs — runs the desktop renderer + the REAL fs-backed server
 * API (src/main-api.cjs, the same module the Electron main process uses) in a
 * plain browser, so the UI can be exercised end-to-end without Electron.
 *
 * The "Demo Vault" (scripts/demo-vault.json — the same seeded vault as the
 * original web edition) is materialized into a fresh temp folder on every run:
 * plain .md files, exactly like a real vault.
 *
 *     node scripts/serve-web-demo.mjs        →  http://127.0.0.1:8124/
 */
import http from "http"
import fs from "fs"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"
import { createServerApi } from "../src/main-api.cjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const obsidian = path.resolve(HERE, "..")
const RENDERER = path.join(obsidian, "src", "renderer")
const PORT = Number(process.env.PORT || 8124)

/* ── 1. materialize the demo vault into a fresh temp folder ───────────────── */

const demoData = JSON.parse(fs.readFileSync(path.join(HERE, "demo-vault.json"), "utf8"))
const demoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-demo-vault-"))
const demoConfig = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-demo-config-"))

function materialize() {
  const folderPath = new Map() // db folder id → relative path
  const byId = new Map(demoData.folders.map((f) => [f.id, f]))
  function pathOf(f) {
    if (folderPath.has(f.id)) return folderPath.get(f.id)
    const p = f.parentId && byId.has(f.parentId) ? `${pathOf(byId.get(f.parentId))}/${f.name}` : f.name
    folderPath.set(f.id, p)
    return p
  }
  for (const f of demoData.folders) {
    const rel = pathOf(f)
    fs.mkdirSync(path.join(demoRoot, rel), { recursive: true })
  }
  for (const n of demoData.notes) {
    const dir = n.folderId && folderPath.has(n.folderId) ? folderPath.get(n.folderId) : ""
    fs.mkdirSync(path.join(demoRoot, dir), { recursive: true })
    fs.writeFileSync(path.join(demoRoot, dir, `${n.name}.md`), n.content ?? "", "utf8")
  }
}
materialize()

/* ── 2. the same server the Electron main process uses ───────────────────── */

const server = createServerApi({
  configDir: demoConfig,
  createVaultFolder: async () => ({ root: demoRoot, name: demoData.name }),
  trash: async (abs) => fs.rmSync(abs, { recursive: true, force: true }), // demo only — the app uses the Recycle Bin
})

// pre-register the demo vault so the picker shows it immediately
await server.dispatch("createVault", [demoData.name])
console.log(`demo vault: ${demoRoot} (${demoData.notes.length} notes)`)

/* ── 3. tiny static server + API bridge ──────────────────────────────────── */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".opus": "audio/opus",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".m4v": "video/mp4",
  ".pdf": "application/pdf",
}

const VAULT_FILE_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
  "image/svg+xml", "image/x-icon",
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/flac", "audio/aac", "audio/opus",
  "video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-matroska",
  "application/pdf", "text/plain",
])

const SHIM = `// Browser stand-in for the Electron preload bridge (demo only).
window.desktop = {
  invoke: (op, args, ctx) =>
    fetch('/api-op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, args: args ?? [], ctx: ctx ?? {} }),
    }).then((r) => r.json()),
  openExternal: async (url) => {
    if (window.confirm('Open ' + url + ' in your browser?')) window.open(url, '_blank')
    return 'opened'
  },
  revealItem: async () => 'unavailable',
  openPath: async () => 'unavailable',
  openNoteWindow: async (noteId, subpath) => {
    const sub = subpath ? '&sub=' + encodeURIComponent(subpath) : ''
    window.open(location.origin + '/?openNote=' + encodeURIComponent(noteId) + sub, '_blank')
    return 'opened'
  },
  onInvalidate: () => () => {},
  onMenu: () => () => {},
  onPrepareClose: () => () => {},
  onThemeSync: () => () => {},
  readyToClose: () => {},
  platform: 'web-demo',
}`

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

    if (req.method === "POST" && url.pathname === "/api-op") {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const { op, args, ctx } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
      try {
        const data = await server.dispatch(op, args, ctx)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, data }))
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
      }
      return
    }

    if (url.pathname === "/desktop-shim.js") {
      res.writeHead(200, { "Content-Type": MIME[".js"] })
      res.end(SHIM)
      return
    }

    if (url.pathname.startsWith("/vault-file/")) {
      const rest = url.pathname.slice("/vault-file/".length)
      const slash = rest.indexOf("/")
      if (slash === -1) {
        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("not found")
        return
      }
      let vaultId, relPath
      try {
        vaultId = decodeURIComponent(rest.slice(0, slash))
        relPath = rest.slice(slash + 1).split("/").map(decodeURIComponent).join("/")
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end("bad request")
        return
      }
      if (vaultId.includes("\0") || relPath.includes("\0")) {
        res.writeHead(400, { "Content-Type": "text/plain" })
        res.end("bad request")
        return
      }
      const mime = MIME[path.extname(relPath).toLowerCase()]
      if (!mime || !VAULT_FILE_MIME.has(mime)) {
        res.writeHead(403, { "Content-Type": "text/plain" })
        res.end("blocked file type")
        return
      }
      try {
        const { base64 } = await server.dispatch("readVaultBinary", [vaultId, relPath], { vaultId })
        const headers = {
          "Content-Type": mime,
          "X-Content-Type-Options": "nosniff",
        }
        if (mime === "image/svg+xml") {
          headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
        }
        res.writeHead(200, headers)
        res.end(Buffer.from(base64, "base64"))
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("not found")
      }
      return
    }

    let file = null
    if (url.pathname === "/") file = path.join(RENDERER, "index.html")
    else if (!url.pathname.includes("..")) file = path.join(RENDERER, url.pathname.slice(1))

    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("not found")
      return
    }

    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" })
    if (path.basename(file) === "index.html") {
      // inject the browser shim before the app bundle
      const html = fs.readFileSync(file, "utf8").replace(
        '<script src="assets/app.js"></script>',
        '<script src="/desktop-shim.js"></script>\n    <script src="assets/app.js"></script>',
      )
      res.end(html)
    } else {
      fs.createReadStream(file).pipe(res)
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" })
    res.end(String(err?.stack ?? err))
  }
})

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`\nobsidian desktop UI (demo mode) → http://127.0.0.1:${PORT}/`)
  console.log("Serving the production renderer bundle + the production fs-backed API.\n")
})
