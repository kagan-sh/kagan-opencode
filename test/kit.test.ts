import { expect, test } from "bun:test"
import type { PermissionDomain } from "@opencode/plugin/promise/permission"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { readFile, readdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { createKit, type PluginRow } from "../src/kit.ts"
import { assertId, ensurePluginsRoot, installedDir, isPluginPath, stagedDir, stagingRoot } from "../src/paths.ts"
import { history, promote } from "../src/promote.ts"
import { scaffold } from "../src/scaffold.ts"
import { extensionTools, type ToolDeps } from "../src/tools.ts"
import { memory, project } from "./support.ts"

interface Asked {
  action: string
  resources: readonly string[]
  save?: readonly string[]
  metadata?: Record<string, unknown>
}

const permission = (asked: Asked[], allow = true): Pick<PermissionDomain, "assert"> =>
  ({
    assert: async (input: { action: string; resources: readonly string[]; save?: readonly string[]; metadata?: Record<string, unknown> }) => {
      asked.push({ action: input.action, resources: input.resources, save: input.save, metadata: input.metadata })
      if (!allow) throw new Error("the person said no")
    },
  }) as unknown as Pick<PermissionDomain, "assert">

const context = () =>
  ({
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    signal: new AbortController().signal,
    progress: async () => undefined,
  }) as unknown as ToolContext

const rows: PluginRow[] = [
  { id: "hello", source: { type: "local", path: "" }, state: { status: "active" } },
  { id: "broken", source: { type: "local", path: "" }, state: { status: "failed", error: "boom" } },
]

function tools(dir: string, allow = true, pluginRows: readonly PluginRow[] = rows) {
  const asked: Asked[] = []
  const kit = createKit({ project: dir, plugins: async () => pluginRows, storage: memory() })
  const deps: ToolDeps = { kit, project: dir, permission: permission(asked, allow) }
  const byName = new Map(extensionTools(deps).map((tool) => [tool.name, tool]))
  const call = async (name: string, input: Record<string, unknown> = {}) =>
    String((await byName.get(name)!.execute(input, context())).content)
  return { kit, call, asked }
}

const index = (id: string, extra = "") =>
  `import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({ id: "${id}", setup() {} })\n${extra}`

test("ids cannot escape the staging folder", () => {
  for (const bad of ["../x", "a/b", "A", "x", "", "-a", 7, undefined]) expect(() => assertId(bad)).toThrow()
  expect(stagedDir("/p", "hello")).toBe(path.join("/p", ".opencode", "staging", "hello"))
  expect(isPluginPath("/p", ".opencode/plugins/x/index.ts")).toBe(true)
  expect(isPluginPath("/p", ".opencode/plugins-other/x.ts")).toBe(false)
  expect(isPluginPath("/p", ".opencode/staging/x/index.ts")).toBe(false)
})

test("a scaffolded server extension typechecks against the kit's pinned types", async () => {
  const dir = await project()
  const made = await scaffold(dir, "hello", "server")
  expect(made.files).toEqual(["index.ts"])
  expect(await tools(dir).kit.check("hello")).toEqual([])
})

test("a scaffolded tui extension typechecks and ships tui.tsx", async () => {
  const dir = await project()
  const made = await scaffold(dir, "panel", "tui")
  expect(made.files).toContain("tui.tsx")
  expect(await tools(dir).kit.check("panel")).toEqual([])
})

test("scaffold refuses to overwrite and refuses a bad id", async () => {
  const dir = await project()
  await scaffold(dir, "hello", "server")
  await expect(scaffold(dir, "hello", "server")).rejects.toThrow()
  await expect(scaffold(dir, "Hello", "server")).rejects.toThrow()
})

test("check names a v1 import, a wrong id and a missing Plugin.define", async () => {
  const dir = await project()
  await scaffold(dir, "hello", "server")
  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), 'import { x } from "@opencode-ai/plugin"\nexport default { id: "other" }\n')
  const problems = await tools(dir).kit.check("hello")
  expect(problems.some((problem) => problem.includes("v1"))).toBe(true)
  expect(problems.some((problem) => problem.includes("Plugin.define"))).toBe(true)
  expect(problems.some((problem) => problem.includes('"other"'))).toBe(true)
})

test("check catches a type error without running the extension", async () => {
  const dir = await project()
  await scaffold(dir, "hello", "server")
  await writeFile(
    path.join(stagedDir(dir, "hello"), "index.ts"),
    'import { Plugin } from "@opencode/plugin"\n\nexport default Plugin.define({\n  id: "hello",\n  setup: async (ctx) => {\n    const tools: number = ctx.tool\n  },\n})\n',
  )
  const problems = await tools(dir).kit.check("hello")
  expect(problems.length).toBeGreaterThan(0)
  expect(problems.join("\n")).toContain("index.ts")
})

test("the id in tui.tsx is checked against the folder too", async () => {
  const dir = await project()
  await scaffold(dir, "panel", "tui")
  await writeFile(path.join(stagedDir(dir, "panel"), "tui.tsx"), 'import { Plugin } from "@opencode/plugin/tui"\nexport default Plugin.define({ id: "other.tui", setup() {} })\n')
  const problems = await tools(dir).kit.check("panel")
  expect(problems.some((problem) => problem.includes('"other.tui"'))).toBe(true)
})

test("the approval lists every file with its size and hash", async () => {
  const dir = await project()
  const { kit } = tools(dir)
  await scaffold(dir, "hello", "server")
  const shown = await kit.describe("hello")
  expect(shown.text).toContain("hash " + shown.hash)
  expect(shown.text).toContain("index.ts")
  expect(shown.text).toMatch(/index\.ts\s+\d+ B\s+sha256 [0-9a-f]{12}/)
  expect(shown.text).toContain("+")
})

test("the patch is one addition hunk with every staged line and the hash", async () => {
  const dir = await project()
  const { kit } = tools(dir)
  await scaffold(dir, "hello", "server")
  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), index("hello", "// second line\n"))
  const { hash, patch } = await kit.describe("hello")

  expect(patch.startsWith("--- /dev/null\n+++ b/.opencode/plugins/hello\n@@ -0,0 +1,")).toBe(true)
  expect(patch).toContain("+extension hello  hash " + hash)
  expect(patch).toContain("+  index.ts")
  expect(patch).toContain('+import { Plugin } from "@opencode/plugin"')
  expect(patch).toContain("+// second line")
  expect(patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length).toBe(Number(/@@ -0,0 \+1,(\d+) @@/.exec(patch)![1]))
})

test("the promote description does not claim an instant load", () => {
  const dir = "/work/app"
  const tool = new Map(extensionTools({ kit: createKit({ project: dir, plugins: async () => [], storage: memory() }), project: dir, permission: { assert: async () => undefined } as never }).map((item) => [item.name, item])).get("ext_promote")!
  expect(tool.description).not.toContain("loads at once")
  expect(tool.description).toContain("restart opencode")
})

test("an approval is refused when staging changed after it was shown", async () => {
  const dir = await project()
  const { kit } = tools(dir)
  await scaffold(dir, "hello", "server")
  const { hash } = await kit.describe("hello")
  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), index("hello", "// edited after the person looked\n"))

  await expect(kit.approve("hello", hash, "tool")).rejects.toThrow("changed since it was shown")
  expect(await readdir(path.join(dir, ".opencode", "plugins")).catch(() => [])).toEqual([])
})

test("the copy is hashed before the rename, so a drift never installs", async () => {
  const dir = await project()
  await scaffold(dir, "hello", "server")
  await expect(promote(dir, "hello", "000000000000")).rejects.toThrow("changed after it was shown")
  expect(await readdir(path.join(dir, ".opencode", "plugins")).catch(() => [])).toEqual([])
  expect(await readdir(path.join(dir, ".opencode", "staging", ".tmp"))).toEqual([])
})

test("a binary file is refused, because it cannot be shown", async () => {
  const dir = await project()
  const { kit } = tools(dir)
  await scaffold(dir, "hello", "server")
  await writeFile(path.join(stagedDir(dir, "hello"), "blob.bin"), Buffer.from([0x00, 0x01, 0x02]))

  expect((await kit.check("hello")).some((problem) => problem.includes("cannot approve it"))).toBe(true)
  await expect(kit.describe("hello")).rejects.toThrow("cannot be promoted")
})

test("a change too large to show is refused, not cut", async () => {
  const dir = await project()
  const { kit } = tools(dir)
  await scaffold(dir, "big", "server")
  await writeFile(path.join(stagedDir(dir, "big"), "index.ts"), index("big", `// ${"x".repeat(13_000)}`))

  await expect(kit.describe("big")).rejects.toThrow("cannot be shown in full")
})

test("the size limit measures the staged text, not the diff against the installed copy", async () => {
  const dir = await project()
  const { kit } = tools(dir)
  await scaffold(dir, "hello", "server")
  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), index("hello", `// ${"a".repeat(7_000)}`))
  await kit.approve("hello", (await kit.describe("hello")).hash, "tool")
  // Both versions are under the limit; the diff between them repeats both, so it is not.
  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), index("hello", `// ${"b".repeat(7_000)}`))

  const shown = await kit.describe("hello")
  expect(shown.text.length).toBeGreaterThan(12_000)
})

test("approve refuses code that ext_check rejects", async () => {
  const dir = await project()
  const { kit } = tools(dir)
  await scaffold(dir, "hello", "server")
  await writeFile(
    path.join(stagedDir(dir, "hello"), "index.ts"),
    'import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({\n  id: "hello",\n  setup: async (ctx) => {\n    const tools: number = ctx.tool\n  },\n})\n',
  )
  const { hash } = await kit.describe("hello")
  await expect(kit.approve("hello", hash, "tool")).rejects.toThrow("cannot be promoted")
})

test("promote copies into plugins and keeps the version it replaced", async () => {
  const dir = await project()
  const { call } = tools(dir)
  await call("ext_new", { id: "hello", kind: "server" })
  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), index("hello", "// one\n"))
  await call("ext_promote", { id: "hello" })
  expect(await readdir(installedDir(dir, "hello"))).toEqual(["index.ts"])

  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), index("hello", "// two\n"))
  await call("ext_promote", { id: "hello" })
  expect((await history(dir, "hello")).length).toBe(1)

  await call("ext_revert", { id: "hello" })
  expect(await readFile(path.join(installedDir(dir, "hello"), "index.ts"), "utf8")).toContain("// one")

  await call("ext_remove", { id: "hello" })
  expect(await readdir(path.join(dir, ".opencode", "plugins"))).toEqual([])
  expect(await tools(dir).kit.check("hello")).toEqual([])
})

test("the person is asked for a promote as an edit whose dialog carries the whole change", async () => {
  const dir = await project()
  const { call, kit, asked } = tools(dir, false)
  await call("ext_new", { id: "hello", kind: "server" })
  const { hash } = await kit.describe("hello")

  const reply = await call("ext_promote", { id: "hello" }).catch((error: Error) => error.message)
  expect(reply).toContain("the person declined to promote hello")
  expect(reply).toContain("nothing was installed")
  expect(asked).toHaveLength(1)
  expect(asked[0]!.action).toBe("edit")
  expect(asked[0]!.resources).toEqual([path.join(".opencode", "plugins", "hello"), `hello@${hash}`])
  expect(asked[0]!.save).toEqual([])
  expect(asked[0]!.metadata?.kit).toBe("promote")
  expect(String(asked[0]!.metadata?.diff)).toContain("+extension hello  hash " + hash)
  expect(String(asked[0]!.metadata?.diff)).toContain('+import { Plugin } from "@opencode/plugin"')
  expect(await readdir(path.join(dir, ".opencode", "plugins")).catch(() => [])).toEqual([])
  expect(await readdir(stagedDir(dir, "hello"))).toContain("index.ts")
})

test("a deny rule is reported as a rule, not as the person declining", async () => {
  const dir = await project()
  const kit = createKit({ project: dir, plugins: async () => [], storage: memory() })
  const permission = {
    assert: async () => {
      throw new Error("Permission denied: edit")
    },
  } as unknown as Pick<PermissionDomain, "assert">
  const promote = new Map(extensionTools({ kit, project: dir, permission }).map((tool) => [tool.name, tool])).get("ext_promote")!
  await scaffold(dir, "hello", "server")

  const message = await promote.execute({ id: "hello" }, context()).catch((error: Error) => error.message)
  expect(message).toContain("a permission rule denied promote hello")
  expect(message).toContain("nothing was installed")
  expect(await readdir(path.join(dir, ".opencode", "plugins")).catch(() => [])).toEqual([])
})

test("an edit while the person decides is refused, and the edited content never installs", async () => {  const dir = await project()
  const kit = createKit({ project: dir, plugins: async () => [], storage: memory() })
  const file = path.join(stagedDir(dir, "hello"), "index.ts")
  // The fake ask edits staging, as another process could while the dialog is open.
  const permission = {
    assert: async () => {
      await writeFile(file, index("hello", "// edited while the person was deciding\n"))
    },
  } as unknown as Pick<PermissionDomain, "assert">
  const promote = new Map(extensionTools({ kit, project: dir, permission }).map((tool) => [tool.name, tool])).get("ext_promote")!
  await scaffold(dir, "hello", "server")

  await expect(promote.execute({ id: "hello" }, context())).rejects.toThrow("changed since it was shown")
  expect(await readdir(path.join(dir, ".opencode", "plugins")).catch(() => [])).toEqual([])
  expect(await readFile(file, "utf8")).toContain("deciding")
})

test("ext_remove and ext_revert ask too", async () => {
  const dir = await project()
  const { call, asked } = tools(dir)
  await call("ext_new", { id: "hello", kind: "server" })
  await call("ext_promote", { id: "hello" })
  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), index("hello", "// two\n"))
  await call("ext_promote", { id: "hello" })
  await call("ext_revert", { id: "hello" })
  await call("ext_remove", { id: "hello" })

  expect(asked.map((entry) => entry.action)).toEqual(["edit", "edit", "ext.revert", "ext.remove"])
  expect(asked.slice(-2).map((entry) => entry.resources)).toEqual([["hello"], ["hello"]])
})

test("promote refuses a staged extension with problems and does not ask", async () => {
  const dir = await project()
  const { call, asked } = tools(dir)
  await call("ext_new", { id: "hello", kind: "server" })
  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), "export const nothing = true\n")

  await expect(call("ext_promote", { id: "hello" })).rejects.toThrow("refused")
  expect(asked).toEqual([])
  expect(await readdir(path.join(dir, ".opencode", "plugins")).catch(() => [])).toEqual([])
})

test("ext_status shows staged, installed and failed plugins with the error", async () => {
  const dir = await project()
  const { call } = tools(dir)
  await call("ext_new", { id: "hello", kind: "server" })
  await call("ext_promote", { id: "hello" })
  const reply = await call("ext_status")
  expect(reply).toContain("staged: hello (installed)")
  expect(reply).toContain("installed: hello active")
  expect(reply).toContain("broken: boom")
  expect(reply).toContain("promote hello via tool")
})

test("ext_new and ext_check print the type folders", async () => {
  const dir = await project()
  const { call } = tools(dir)
  const created = await call("ext_new", { id: "hello", kind: "server" })
  expect(created).toContain("dist/promise")
  expect(created).toContain("dist/tui")
  expect(await call("ext_check", { id: "hello" })).toContain("dist/promise")
})

test("the audit trail keeps who promoted what, newest first", async () => {
  const dir = await project()
  const storage = memory()
  const changes: string[] = []
  const kit = createKit({
    project: dir,
    plugins: async () => [],
    storage,
    onChange: async (change) => void changes.push(`${change.action} ${change.id}`),
  })
  await scaffold(dir, "hello", "server")
  await kit.approve("hello", (await kit.describe("hello")).hash, "tool")
  await kit.approve("hello", (await kit.describe("hello")).hash, "rpc")
  const trail = await kit.snapshot()
  expect(trail.audit.length).toBe(2)
  expect(trail.audit[0]!.via).toBe("rpc")
  expect(trail.audit[0]!.hash.length).toBe(12)
  // the TUI hears these and reloads the location
  expect(changes).toEqual(["promote hello", "promote hello"])
})

test("symlinks are refused, not followed", async () => {
  const dir = await project()
  await scaffold(dir, "hello", "server")
  await symlink("/etc/hosts", path.join(stagedDir(dir, "hello"), "leak.ts"))
  expect((await tools(dir).kit.check("hello")).some((problem) => problem.includes("symlink"))).toBe(true)
})

test("staging and history stay out of the plugins folder", async () => {
  const dir = await project()
  const { call } = tools(dir)
  await call("ext_new", { id: "hello", kind: "server" })
  await call("ext_promote", { id: "hello" })
  await call("ext_new", { id: "other", kind: "server" })
  expect(await readdir(stagingRoot(dir))).toContain("other")
  expect(await readdir(path.join(dir, ".opencode", "plugins"))).toEqual(["hello"])
})

test("setup makes only the plugins folder the loader watches", async () => {
  const dir = await project()
  await ensurePluginsRoot(dir)
  expect(await readdir(path.join(dir, ".opencode"))).toEqual(["plugins"])
})
