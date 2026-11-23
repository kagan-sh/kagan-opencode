import { describe, expect, test } from "bun:test"
import type { PermissionDomain } from "@opencode/plugin/promise/permission"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createKit, type PluginRow } from "../src/kit.ts"
import { assertId, installedDir, isPluginPath, stagedDir, stagingRoot } from "../src/paths.ts"
import { history } from "../src/promote.ts"
import { scaffold } from "../src/scaffold.ts"
import { extensionTools, type ToolDeps } from "../src/tools.ts"

const project = () => mkdtemp(path.join(tmpdir(), "kagan-ext-"))

function memory(): StorageDomain {
  const values = new Map<string, Parameters<StorageDomain["set"]>[1]>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    scan: async (options) => ({
      entries: [...values.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value })),
    }),
  } as StorageDomain
}

const asked: { action: string; resources: readonly string[] }[] = []
const permission = (allow = true): Pick<PermissionDomain, "assert"> =>
  ({
    assert: async (input: { action: string; resources: readonly string[] }) => {
      asked.push({ action: input.action, resources: input.resources })
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
  const kit = createKit({ project: dir, plugins: async () => pluginRows, storage: memory() })
  const deps: ToolDeps = { kit, project: dir, permission: permission(allow) }
  const byName = new Map(extensionTools(deps).map((tool) => [tool.name, tool]))
  const call = async (name: string, input: Record<string, unknown> = {}) =>
    String((await byName.get(name)!.execute(input, context())).content)
  return { kit, call }
}

test("ids cannot escape the staging folder", () => {
  for (const bad of ["../x", "a/b", "A", "x", "", "-a", 7, undefined]) expect(() => assertId(bad)).toThrow()
  expect(stagedDir("/p", "hello")).toBe(path.join("/p", ".opencode", "staging", "hello"))
  expect(isPluginPath("/p", ".opencode/plugins/x/index.ts")).toBe(true)
  expect(isPluginPath("/p", ".opencode/plugins-other/x.ts")).toBe(false)
  expect(isPluginPath("/p", ".opencode/staging/x/index.ts")).toBe(false)
})

test("a scaffolded server extension typechecks against the host's types", async () => {
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

test("promote copies into plugins and keeps the version it replaced", async () => {
  const dir = await project()
  const { call } = tools(dir)
  await call("ext_new", { id: "hello", kind: "server" })
  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), 'import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({ id: "hello", setup() {} })\n// one\n')
  await call("ext_promote", { id: "hello" })
  expect(await readdir(installedDir(dir, "hello"))).toEqual(["index.ts"])

  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), 'import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({ id: "hello", setup() {} })\n// two\n')
  await call("ext_promote", { id: "hello" })
  expect((await history(dir, "hello")).length).toBe(1)

  await call("ext_revert", { id: "hello" })
  expect(await readFile(path.join(installedDir(dir, "hello"), "index.ts"), "utf8")).toContain("// one")

  await call("ext_remove", { id: "hello" })
  expect(await readdir(path.join(dir, ".opencode", "plugins"))).toEqual([])
  expect(await tools(dir).kit.check("hello")).toEqual([])
})

test("the person is asked before anything is copied", async () => {
  const dir = await project()
  const { call } = tools(dir, false)
  await call("ext_new", { id: "hello", kind: "server" })
  const reply = await call("ext_promote", { id: "hello" }).catch((error: Error) => error.message)
  expect(reply).toContain("the person said no")
  expect(await readdir(path.join(dir, ".opencode", "plugins")).catch(() => [])).toEqual([])
  expect(await readdir(stagedDir(dir, "hello"))).toContain("index.ts")
})

test("promote refuses a staged extension with problems and does not ask", async () => {
  const dir = await project()
  const { call } = tools(dir)
  await call("ext_new", { id: "hello", kind: "server" })
  await writeFile(path.join(stagedDir(dir, "hello"), "index.ts"), "export const nothing = true\n")
  await expect(call("ext_promote", { id: "hello" })).rejects.toThrow("refused")
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
  await kit.approve("hello", "tool")
  await kit.approve("hello", "tui")
  const trail = await kit.snapshot()
  expect(trail.audit.length).toBe(2)
  expect(trail.audit[0]!.via).toBe("tui")
  expect(trail.audit[0]!.hash.length).toBe(12)
  // the TUI hears these and reloads the location
  expect(changes).toEqual(["promote hello", "promote hello"])
})

test("symlinks are refused, not followed", async () => {
  const dir = await project()
  await scaffold(dir, "hello", "server")
  const { symlink } = await import("node:fs/promises")
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
