import { expect, test } from "bun:test"
import { readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { handlers } from "../src/handlers.ts"
import { createKit } from "../src/kit.ts"
import { installedDir, stagedDir } from "../src/paths.ts"
import { scaffold } from "../src/scaffold.ts"
import { memory, project } from "./support.ts"

const setup = async () => {
  const dir = await project()
  const kit = createKit({ project: dir, plugins: async () => [], storage: memory() })
  await scaffold(dir, "hello", "server")
  return { dir, kit, rpc: handlers(kit) }
}

test("diff returns the text and the hash it was computed from", async () => {
  const { rpc, kit } = await setup()
  const diff = await rpc.diff({ id: "hello" })
  expect(diff.text).toContain("extension hello")
  expect(diff.hash).toBe((await kit.describe("hello")).hash)
})

test("approve installs only the hashed content and records via rpc", async () => {
  const { dir, kit, rpc } = await setup()
  const { hash } = await rpc.diff({ id: "hello" })
  const reply = await rpc.approve({ id: "hello", hash })
  expect(reply.ok).toBe(true)
  expect(await readdir(installedDir(dir, "hello"))).toEqual(["index.ts"])

  const trail = await kit.snapshot()
  expect(trail.audit[0]!.via).toBe("rpc")
  expect(trail.audit[0]!.hash).toBe(hash)
})

test("approve refuses a hash from before an edit, and installs nothing", async () => {
  const { dir, rpc } = await setup()
  const { hash } = await rpc.diff({ id: "hello" })
  await writeFile(
    path.join(stagedDir(dir, "hello"), "index.ts"),
    'import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({ id: "hello", setup() {} })\n// changed\n',
  )

  const reply = await rpc.approve({ id: "hello", hash })
  expect(reply.ok).toBe(false)
  expect(reply.message).toContain("changed since it was shown")
  expect(await readdir(path.join(dir, ".opencode", "plugins")).catch(() => [])).toEqual([])
})

test("approve without a hash is a refusal, not an install", async () => {
  const { dir, rpc } = await setup()
  const reply = await rpc.approve({ id: "hello" })
  expect(reply.ok).toBe(false)
  expect(reply.message).toContain("content hash")
  expect(await readdir(path.join(dir, ".opencode", "plugins")).catch(() => [])).toEqual([])
})

test("reject, remove and revert answer over the RPC", async () => {
  const { dir, rpc } = await setup()
  const { hash } = await rpc.diff({ id: "hello" })
  await rpc.approve({ id: "hello", hash })
  await writeFile(
    path.join(stagedDir(dir, "hello"), "index.ts"),
    'import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({ id: "hello", setup() {} })\n// two\n',
  )
  const second = await rpc.diff({ id: "hello" })
  await rpc.approve({ id: "hello", hash: second.hash })

  expect((await rpc.revert({ id: "hello" })).ok).toBe(true)
  expect((await rpc.remove({ id: "hello" })).message).toContain("removed hello")
  expect((await rpc.reject({ id: "hello" })).ok).toBe(true)
  expect(await readdir(stagedDir(dir, "hello")).catch(() => [])).toEqual([])
})
