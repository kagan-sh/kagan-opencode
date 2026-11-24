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
  for (const file of [
    "opencode.json",
    "opencode.jsonc",
    "tui.json",
    ".opencode/opencode.json",
    ".opencode/opencode.jsonc",
    ".opencode/tui.json",
    ".opencode/package.json",
  ]) {
    const event = evaluate("edit", [`/work/app/${file}`])
    await guard(project, event)
    expect(event.effect, file).toBe("ask")
  }
})

test("the global TUI config is watched too", async () => {
  const config = await mkdtemp(path.join(tmpdir(), "kagan-config-"))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = config
  try {
    const event = evaluate("edit", [path.join(config, "opencode", "tui.json")])
    await guard(project, event)
    expect(event.effect).toBe("ask")
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
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

test("the guard's reason reaches the person through the notice", async () => {
  const seen: string[] = []
  const event = evaluate("edit", [".opencode/plugins/x/index.ts"])
  await guard(project, event, (message) => void seen.push(message))
  expect(event.effect).toBe("ask")
  expect(seen).toEqual([event.message!])
})

test("the kit's own promote ask is a question, and it says what it is", async () => {
  const seen: string[] = []
  const event: Evaluation = {
    action: "edit",
    resources: [".opencode/plugins/hello", "hello@abcdef123456"],
    metadata: { kit: "promote", diff: "+..." },
    effect: "allow",
  }
  await guard(project, event, (message) => void seen.push(message))
  expect(event.effect).toBe("ask")
  expect(event.message!).toContain("whole change and hash")
  expect(seen).toEqual([event.message!])
})

test("a shell command that writes into plugins becomes a question", async () => {
  for (const command of [
    "echo hi > .opencode/plugins/x/index.ts",
    "cp /tmp/x.ts .opencode/plugins/x/index.ts",
    "rm -rf /work/app/.opencode/plugins/x",
    "mkdir -p .opencode/plugins/x",
    "cp -r .opencode/staging/sneaky .opencode/plugins/sneaky",
    "cd .opencode && cp -r staging/sneaky plugins/",
    "d=.opencode; p=plug; cp -r $d/staging/sneaky \"$d/${p}ins/\"",
    "cd .opencode/staging && cp -r sneaky ../plug*/",
    "ln -s $PWD/.opencode/staging/sneaky .opencode/plugins/sneaky",
    "cat > .opencode/plugins/x/index.ts",
    "echo 'export default 1' | base64 | xargs -I{} sh -c 'echo {} | base64 -d' > .opencode/plugins/a.ts",
    "tar -xf x.tar -C .opencode/plugins",
    "git checkout other-branch -- .opencode/plugins",
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
    "u=api; curl -X POST \"http://127.0.0.1:4096/$u/rpc/kagan\".ext/approve",
    "r=rpc; n=kagan; curl -X POST \"http://127.0.0.1:4096/api/$r/$n.ext/approve\"",
    "bun -e \"fetch('http://127.0.0.1:4096/'+'api/r'+'pc/kag'+'an.ext/approve',{method:'POST'})\"",
  ]) {
    const event = evaluate("shell", [command])
    await guard(project, event)
    expect(event.effect, command).toBe("ask")
  }
})

test("reading the folder, mentioning the RPC path or writing elsewhere is not flagged", async () => {
  for (const command of [
    "ls .opencode/plugins",
    "ls .opencode 2>/dev/null",
    "cat .opencode/plugins/x/index.ts",
    "grep -rn \"api/rpc\" node_modules/@opencode/client 2>/dev/null | head -5",
    "grep -rn \"kagan.ext\" src",
    "git status",
    "echo hi > /tmp/x",
  ]) {
    const event = evaluate("shell", [command])
    await guard(project, event)
    expect(event.effect, command).toBe("allow")
  }
})
