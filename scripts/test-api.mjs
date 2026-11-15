/*
 * test-api.mjs — exercises the fs-backed server API (src/main-api.cjs) against
 * a throwaway vault folder: the same module the Electron main process uses.
 *
 *     node scripts/test-api.mjs
 */
import fs from "fs"
import path from "path"
import os from "os"
import assert from "assert"
import { createServerApi } from "../src/main-api.cjs"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-test-vault-"))
const config = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-test-config-"))
const trashed = []

const server = createServerApi({
  configDir: config,
  createVaultFolder: async (name) => ({ root, name }),
  trash: async (abs) => {
    trashed.push(abs)
    fs.rmSync(abs, { recursive: true, force: true })
  },
})

const call = (op, ...args) => server.dispatch(op, args, { vaultId: root })
// ops that take the vault id as an explicit first argument (same as the web API)
const vcall = (op, ...args) => server.dispatch(op, [root, ...args], { vaultId: root })
let passed = 0
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  ✓ ${name}`)
    })
    .catch((err) => {
      console.error(`  ✗ ${name}\n    ${err.stack}`)
      process.exitCode = 1
    })
}

console.log("obsidian desktop API tests\n")

await ok("vault registers + lists", async () => {
  const summary = await call("createVault", "Test vault")
  assert.strictEqual(summary.name, "Test vault")
  const list = await call("listVaults")
  assert.strictEqual(list.length, 1)
  assert.ok(list[0].id.endsWith(path.basename(root)) || list[0].id === root)
})

fs.writeFileSync(path.join(root, "Welcome.md"), "# Welcome\n\nSee [[Ideas]] and [[Projects/Deep note]].\n")
fs.mkdirSync(path.join(root, "Projects"), { recursive: true })
fs.writeFileSync(path.join(root, "Projects", "Deep note.md"), "---\ntags: [project, deep]\naliases: [Deep]\n---\n\nBack to [[Welcome]]. #project\n")
fs.writeFileSync(path.join(root, "Orphan.md"), "No links here, but Welcome is mentioned by name.\n")

await ok("tree walks real files", async () => {
  const tree = await vcall("tree")
  assert.ok(tree.folders.some((f) => f.name === "Projects"))
  const welcome = tree.notes.find((n) => n.name === "Welcome")
  assert.strictEqual(welcome.id, "Welcome.md")
  assert.strictEqual(welcome.folderId, null)
  const deep = tree.notes.find((n) => n.name === "Deep note")
  assert.strictEqual(deep.folderId, "Projects")
  assert.strictEqual(deep.path, "Projects/Deep note")
})

await ok("index extracts aliases + tags", async () => {
  const index = await vcall("index")
  const deep = index.find((e) => e.name === "Deep note")
  assert.deepStrictEqual(deep.aliases, ["Deep"])
  assert.ok(deep.tags.includes("project"))
  assert.ok(deep.tags.includes("deep"))
})

await ok("graph builds nodes + links", async () => {
  const g = await vcall("graph")
  assert.ok(g.nodes.length >= 3)
  assert.ok(g.links.some((l) => (l.source === "Welcome.md" && l.target === "Projects/Deep note.md") || (l.target === "Welcome.md" && l.source === "Projects/Deep note.md")))
  assert.ok(g.nodes.some((n) => n.unresolved && n.name === "Ideas"))
})

await ok("search grammar: tag: filter", async () => {
  const res = await vcall("search", "tag:#project", false)
  assert.strictEqual(res.hits.length, 1)
  assert.strictEqual(res.hits[0].name, "Deep note")
})

await ok("search grammar: plain term + negation", async () => {
  // "- x" (dash as its own token) is the negation form, per the shared grammar
  const res = await vcall("search", "Welcome - Orphan", false)
  assert.ok(res.hits.some((h) => h.name === "Welcome"))
  assert.ok(!res.hits.some((h) => h.name === "Orphan"))
})

await ok("note read returns full doc", async () => {
  const note = await call("note", "Projects/Deep note.md")
  assert.ok(note.content.includes("Back to [[Welcome]]"))
  assert.strictEqual(note.name, "Deep note")
})

await ok("backlinks: linked + unlinked mentions", async () => {
  const bl = await call("backlinks", "Welcome.md")
  assert.ok(bl.linked.some((m) => m.noteId === "Projects/Deep note.md"))
  assert.ok(bl.unlinked.some((m) => m.noteId === "Orphan.md"))
})

await ok("createNote writes a file + unique names", async () => {
  const a = await vcall("createNote", "Untitled", null, "first")
  const b = await vcall("createNote", "Untitled", null, "second")
  assert.strictEqual(a.name, "Untitled")
  // duplicates number from 1 (obsidian behaviour: Untitled, Untitled 1, Untitled 2…)
  assert.strictEqual(b.name, "Untitled 1")
  assert.ok(fs.existsSync(path.join(root, "Untitled.md")))
  assert.ok(fs.existsSync(path.join(root, "Untitled 1.md")))
})

await ok("patchNote content autosave path", async () => {
  const note = await call("patchNote", "Untitled.md", { content: "changed" })
  assert.strictEqual(fs.readFileSync(path.join(root, "Untitled.md"), "utf8"), "changed")
  assert.strictEqual(note.content, "changed")
})

await ok("patchNote rename rewrites [[links]] (obsidian behavior)", async () => {
  fs.writeFileSync(path.join(root, "Referrer.md"), "Points at [[Untitled]].\n")
  const renamed = await call("patchNote", "Untitled.md", { name: "Renamed" })
  assert.strictEqual(renamed.id, "Renamed.md")
  assert.ok(!fs.existsSync(path.join(root, "Untitled.md")))
  assert.strictEqual(fs.readFileSync(path.join(root, "Referrer.md"), "utf8"), "Points at [[Renamed]].\n")
})

await ok("patchNote move + unique guard", async () => {
  const moved = await call("patchNote", "Renamed.md", { folderId: "Projects" })
  assert.strictEqual(moved.id, "Projects/Renamed.md")
  assert.strictEqual(fs.readFileSync(path.join(root, "Referrer.md"), "utf8"), "Points at [[Renamed]].\n")
  await assert.rejects(() => call("patchNote", "Projects/Renamed.md", { name: "Deep note" }), /already exists/)
})

await ok("folder rename rewrites path-style links", async () => {
  fs.writeFileSync(path.join(root, "PathLink.md"), "Path: [[Projects/Renamed]].\n")
  await call("patchFolder", "Projects", { name: "Archive" })
  assert.strictEqual(fs.readFileSync(path.join(root, "PathLink.md"), "utf8"), "Path: [[Archive/Renamed]].\n")
  assert.ok(fs.existsSync(path.join(root, "Archive", "Renamed.md")))
})

await ok("folder cycle guard", async () => {
  await assert.rejects(() => call("patchFolder", "Archive", { parentId: "Archive/Sub" }), /into itself/)
})

await ok("deleteNote/deleteFolder go through trash hook", async () => {
  await call("deleteNote", "PathLink.md")
  await call("deleteNote", "Referrer.md")
  await call("deleteFolder", "Archive")
  assert.ok(trashed.some((p) => p.endsWith("Archive")))
  const tree = await vcall("tree")
  assert.ok(!tree.notes.some((n) => n.id === "PathLink.md"))
  assert.ok(!tree.folders.some((f) => f.id === "Archive"))
})

await ok("bookmarks persist inside the vault (.obsidian/)", async () => {
  await call("addBookmark", { vaultId: root, itemType: "note", itemId: "Welcome.md", title: "Welcome" })
  const items = await vcall("bookmarks")
  assert.strictEqual(items.length, 1)
  assert.strictEqual(items[0].title, "Welcome")
  await call("removeBookmark", items[0].id)
  assert.strictEqual((await vcall("bookmarks")).length, 0)
  assert.ok(fs.existsSync(path.join(root, ".obsidian", "bookmarks.json")))
})

await ok("settings merge + persist globally", async () => {
  const s1 = await call("getSettings")
  assert.strictEqual(s1.appearance.theme, "dark")
  const s2 = await call("putSettings", { appearance: { theme: "light" } })
  assert.strictEqual(s2.appearance.theme, "light")
  assert.strictEqual((await call("getSettings")).appearance.theme, "light")
})

await ok("path escape attempts are rejected", async () => {
  await assert.rejects(() => call("note", "../outside.md"), /Invalid path|escapes/)
  await assert.rejects(() => call("note", "a/../../b.md"), /Invalid path|escapes/)
})

await ok("deleteVault unregisters but keeps files", async () => {
  const list = await vcall("listVaults")
  await vcall("deleteVault", list[0].id)
  assert.strictEqual((await vcall("listVaults")).length, 0)
  assert.ok(fs.existsSync(path.join(root, "Welcome.md")))
  await assert.rejects(() => call("note", "Welcome.md"), /not registered/i)
})

console.log(`\n${passed} test groups passed${process.exitCode ? " (with failures)" : ""}`)
fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(config, { recursive: true, force: true })
