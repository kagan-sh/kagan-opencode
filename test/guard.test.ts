import { expect, test } from "bun:test"
import { mkdir, mkdtemp, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { guard, type Evaluation } from "../src/guard.ts"
import { pluginsRoot } from "../src/paths.ts"

const project = "/work/app"

const evaluate = (action: string, resources: string[], effect: Evaluation["effect"] = "allow"): Evaluation => ({
  action,
  resources,
  effect,
})

test("a write into the plugins folder becomes a question", async () => {
  const event = evaluate("edit", ["/work/app/.opencode/plugins/x/index.ts"])
  await guard(project, event)
  expect(event.effect).toBe("ask")
  expect(event.message).toContain("full rights")
})

test("a relative plugin path is caught too", async () => {
  const event = evaluate("edit", [".opencode/plugins/x/index.ts"])
  await guard(project, event)
  expect(event.effect).toBe("ask")
})

test("editing the config that decides what loads becomes a question", async () => {
  for (const file of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]) {
    const event = evaluate("edit", [`/work/app/${file}`])
    await guard(project, event)
    expect(event.effect, file).toBe("ask")
  }
})

test("edits elsewhere and a configured deny are left alone", async () => {
  const source = evaluate("edit", ["/work/app/src/index.ts"])
  await guard(project, source)
  expect(source.effect).toBe("allow")

  const denied = evaluate("edit", ["/work/app/.opencode/plugins/x/index.ts"], "deny")
  await guard(project, denied)
  expect(denied.effect).toBe("deny")
  expect(denied.message).toBeUndefined()
})

test("a symlinked project path is still the same plugin folder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kagan-guard-"))
  const real = path.join(root, "real")
  const link = path.join(root, "link")
  await mkdir(pluginsRoot(real), { recursive: true })
  await symlink(real, link)

  const throughLink = evaluate("edit", [path.join(link, ".opencode", "plugins", "x", "index.ts")])
  await guard(real, throughLink)
  expect(throughLink.effect).toBe("ask")

  const otherWay = evaluate("edit", [path.join(real, ".opencode", "plugins", "x", "index.ts")])
  await guard(link, otherWay)
  expect(otherWay.effect).toBe("ask")
})

test("every ext.* action is a question, even when the person's rules allow it", async () => {
  for (const action of ["ext.promote", "ext.remove", "ext.revert"]) {
    const event = evaluate(action, ["hello@abcdef123456"])
    await guard(project, event)
    expect(event.effect, action).toBe("ask")
  }
})

test("a shell command that writes into plugins becomes a question", async () => {
  for (const command of [
    "echo hi > .opencode/plugins/x/index.ts",
    "cp /tmp/x.ts .opencode/plugins/x/index.ts",
    "rm -rf /work/app/.opencode/plugins/x",
    "mkdir -p .opencode/plugins/x",
  ]) {
    const event = evaluate("shell", [command])
    await guard(project, event)
    expect(event.effect, command).toBe("ask")
  }
})

test("a shell command that calls the approval RPC becomes a question", async () => {
  for (const command of [
    "curl -X POST http://127.0.0.1:4096/api/rpc/kagan.ext/approve -d '{\"input\":{\"id\":\"hello\"}}'",
    "curl http://127.0.0.1:4096/api/rpc/kagan.ext/snapshot",
  ]) {
    const event = evaluate("shell", [command])
    await guard(project, event)
    expect(event.effect, command).toBe("ask")
  }
})

test("reading the folder or working elsewhere is not flagged", async () => {
  for (const command of ["ls .opencode/plugins", "cat .opencode/plugins/x/index.ts", "git status", "echo hi > /tmp/x"]) {
    const event = evaluate("shell", [command])
    await guard(project, event)
    expect(event.effect, command).toBe("allow")
  }
})
