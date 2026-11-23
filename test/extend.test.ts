import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { check } from "../src/check.ts"
import { assertId, stagedDir } from "../src/paths.ts"
import { scaffold } from "../src/scaffold.ts"
import { extensionTools } from "../src/tools.ts"

const project = () => mkdtemp(path.join(tmpdir(), "kagan-ext-"))

test("ids that could escape the staging folder are refused", () => {
  for (const bad of ["../x", "a/b", "A", "x", ""]) expect(() => assertId(bad)).toThrow()
})

test("a fresh server scaffold passes the check and stays in staging", async () => {
  const dir = await project()
  const made = await scaffold(dir, "hello", "server")
  expect(made.dir).toBe(stagedDir(dir, "hello"))
  expect(await check(made.dir, "hello")).toEqual([])
})

test("a tui scaffold adds tui.tsx and exports ./tui", async () => {
  const dir = await project()
  const made = await scaffold(dir, "panel", "tui")
  expect(made.files).toContain("tui.tsx")
  expect(JSON.parse(await readFile(path.join(made.dir, "package.json"), "utf8")).exports["./tui"]).toBe("./tui.tsx")
})

test("scaffold will not overwrite an existing file", async () => {
  const dir = await project()
  await scaffold(dir, "hello", "server")
  await expect(scaffold(dir, "hello", "server")).rejects.toThrow()
})

test("check names a v1 import, a wrong id and a missing Plugin.define", async () => {
  const dir = await project()
  const made = await scaffold(dir, "hello", "server")
  await writeFile(path.join(made.dir, "index.ts"), 'import { x } from "@opencode-ai/plugin"\nexport default { id: "other" }\n')
  const problems = await check(made.dir, "hello")
  expect(problems.some((p) => p.includes("v1"))).toBe(true)
  expect(problems.some((p) => p.includes("Plugin.define"))).toBe(true)
  expect(problems.some((p) => p.includes('"other"'))).toBe(true)
})

test("ext_status reports a failed plugin with its error", async () => {
  const dir = await project()
  const [, , status] = extensionTools({
    project: dir,
    plugins: async () => [{ id: "bad", source: {}, state: { status: "failed", error: "boom" } }],
  })
  expect((await status!.execute({})).content).toContain("FAILED bad: boom")
})
