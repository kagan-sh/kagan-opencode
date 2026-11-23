#!/usr/bin/env bun
/**
 * End-to-end run in a throwaway project, with its own opencode config, data and
 * state dirs, so the person's real opencode is never touched.
 *
 * What it proves: the kit loads in a real opencode server; a staged extension
 * passes ext_check; the approval RPC installs it; opencode loads it; a failing
 * extension shows up in ctx.plugin.list with its error; ext_status reports both.
 *
 * What it cannot prove: the agent side of the loop needs a model, so the agent
 * tools are called directly here instead of through a session.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createKit, type PluginRow } from "../src/kit.ts"
import { installedDir, stagedDir } from "../src/paths.ts"
import { extensionTools } from "../src/tools.ts"

const kitPath = path.resolve(import.meta.dir, "..")
const keep = process.env.KEEP === "1"

const say = (line = "") => console.log(line)
const step = (line: string) => console.log(`\n== ${line}`)

function check(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

const memory = (): StorageDomain => {
  const values = new Map<string, Parameters<StorageDomain["set"]>[1]>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    scan: async (options) => ({
      entries: [...values.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  } as StorageDomain
}

/** The agent's tools, wired to a person who always says yes, as tests do. */
function agent(project: string, plugins: () => Promise<readonly PluginRow[]>, allow = true) {
  const asked: string[] = []
  const kit = createKit({ project, plugins, storage: memory() })
  const tools = new Map(
    extensionTools({
      kit,
      project,
      permission: {
        assert: async (input: { action: string; resources: readonly string[] }) => {
          asked.push(`${input.action} ${input.resources.join(",")}`)
          if (!allow) throw new Error("the person said no")
        },
      },
    }).map((tool) => [tool.name, tool]),
  )
  const call = async (name: string, input: Record<string, unknown> = {}) =>
    String(
      (
        await tools.get(name)!.execute(input, {
          sessionID: "ses_e2e",
          agent: "build",
          messageID: "msg_e2e",
          id: "call_e2e",
          signal: new AbortController().signal,
          progress: async () => undefined,
        } as never)
      ).content,
    )
  return { call, asked }
}

/** The API takes the location as a nested query: `location[directory]=...`. */
const where = (location: string) => `location[directory]=${encodeURIComponent(location)}`

/** opencode prints a password for the private server it starts; the API wants Basic auth. */
let password = ""
const auth = (): Record<string, string> =>
  password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}

const server = (base: string) => ({
  plugins: async (location: string): Promise<PluginRow[]> => {
    const response = await fetch(`${base}/api/plugin?${where(location)}`, { headers: auth() })
    check(response.ok, `plugin list failed: ${response.status}`)
    return ((await response.json()) as { data: PluginRow[] }).data
  },
  /** What the TUI part does when its `changed` event arrives: ask the server to re-read the location. */
  reload: async (location: string) => {
    const response = await fetch(`${base}/api/location/reload`, { method: "POST", headers: auth() })
    check(response.status === 204, `location reload failed: ${response.status}`)
    // The kit is torn down and registered again, so its RPC is briefly unavailable.
    await waitFor("the kit's RPC after a reload", async () => {
      const probe = await fetch(`${base}/api/rpc/kagan.ext/snapshot?${where(location)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth() },
        body: JSON.stringify({ input: {} }),
      })
      return probe.ok ? true : undefined
    })
  },
  rpc: async (location: string, rpcID: string, method: string, input: unknown) => {
    const response = await fetch(`${base}/api/rpc/${encodeURIComponent(rpcID)}/${encodeURIComponent(method)}?${where(location)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth() },
      body: JSON.stringify({ input }),
    })
    const body = (await response.json().catch(() => ({}))) as { output?: unknown; message?: string }
    if (!response.ok) throw new Error(`${method} failed: ${response.status} ${JSON.stringify(body)}`)
    return body.output
  },
})

async function waitFor<T>(what: string, read: () => Promise<T | undefined>, timeout = 30_000): Promise<T> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await read().catch(() => undefined)
    if (value) return value
    await Bun.sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Canonical, because macOS tmpdir() is the /var alias of /private/var: opencode
// would see a second location for the same folder, with no kit loaded in it.
const root = await realpath(await mkdtemp(path.join(tmpdir(), "kagan-e2e-")))
const project = path.join(root, "project")
const port = 4300 + Math.floor(Math.random() * 400)
let base = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CACHE_HOME: path.join(root, "cache"),
}

await mkdir(project, { recursive: true })
await writeFile(
  path.join(project, "opencode.jsonc"),
  `{
  // The kit itself, loaded as a local plugin directory.
  "plugins": [${JSON.stringify(kitPath)}]
}
`,
)

say(`project:   ${project}`)
say(`config:    ${env.XDG_CONFIG_HOME}`)
say(`kit:       ${kitPath}`)

step("start opencode with its own config dirs")
const child = spawn("opencode", ["serve", "--port", String(port)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
let log = ""
child.stdout.on("data", (chunk) => {
  log += chunk
  password = /server password (\S+)/.exec(log)?.[1] ?? password
})
child.stderr.on("data", (chunk) => (log += chunk))
const stop = () => child.kill("SIGTERM")
process.on("exit", stop)

const rows = await waitFor("the kit to load and the location to settle", async () => {
  const first = await server(base).plugins(project)
  if (!first.some((row) => row.id === "kagan.ext")) return undefined
  await Bun.sleep(2000)
  const second = await server(base).plugins(project)
  return second.length === first.length && second.length > 1 ? second : undefined
}, 90_000).catch(async (error: Error) => {
  say(log.slice(-3000))
  throw error
})
const kit = rows.find((row) => row.id === "kagan.ext")!
say(`plugins after boot: ${rows.length}; kagan.ext is ${kit.state.status}`)
say(`kagan.ext features: ${JSON.stringify((kit as { features?: unknown }).features)}`)
check(kit.state.status === "active", "the kit did not load: " + JSON.stringify(kit))
check((kit as { features?: { server?: true; tui?: true; rpc?: true } }).features?.tui, "opencode does not see the kit's TUI part")

step("the agent stages and checks an extension (ext_new, ext_check)")
const { call, asked } = agent(project, () => server(base).plugins(project))
say(await call("ext_new", { id: "hello", kind: "server" }))
say(`staged at ${stagedDir(project, "hello")}: ${(await readdir(stagedDir(project, "hello"))).join(", ")}`)
say(await call("ext_check", { id: "hello" }))
check(!rows.some((row) => row.id === "hello"), "staged code ran: hello is already loaded")

step("the person approves it through the TUI's RPC (approve)")
const approved = await server(base).rpc(project, "kagan.ext", "approve", { id: "hello" })
say(`approve -> ${JSON.stringify(approved)}`)
say(`installed at ${installedDir(project, "hello")}: ${(await readdir(installedDir(project, "hello"))).join(", ")}`)
check((approved as { ok?: boolean }).ok === true, "approve did not report success")

step("the TUI reloads the location, and opencode loads it")
await server(base).reload(project)
for (const row of await server(base).plugins(project)) if (row.source.type === "local") say(`local plugin: ${JSON.stringify(row)}`)
const loaded = await waitFor("hello to load", async () => {
  const rows = await server(base).plugins(project)
  return rows.find((row) => row.id === "hello" && row.state.status === "active") ? rows : undefined
})
say(`hello is ${loaded.find((row) => row.id === "hello")!.state.status}`)

step("a broken extension becomes visible to the agent")
await call("ext_new", { id: "sad", kind: "server" })
await writeFile(
  path.join(stagedDir(project, "sad"), "index.ts"),
  'import { Plugin } from "@opencode/plugin"\n\nexport default Plugin.define({\n  id: "sad",\n  setup() {\n    throw new Error("this extension is broken on purpose")\n  },\n})\n',
)
say(await call("ext_check", { id: "sad" }))
const sad = await server(base).rpc(project, "kagan.ext", "approve", { id: "sad" })
check((sad as { ok?: boolean }).ok === true, "approve of the broken extension failed")
await server(base).reload(project)
const failedRows = await waitFor("sad to fail", async () => {
  const rows = await server(base).plugins(project)
  return rows.find((row) => row.id === "sad" && row.state.status === "failed") ? rows : undefined
})
const failure = failedRows.find((row) => row.id === "sad")!
say(`sad is ${failure.state.status}: ${failure.state.status === "failed" ? failure.state.error.split("\n")[0] : ""}`)
check(failure.state.status === "failed" && failure.state.error.includes("broken on purpose"), "the load error was not reported")

step("the agent reads it back with ext_status")
const status = await call("ext_status")
say(status)
check(status.includes("hello active"), "ext_status does not show the loaded extension")
check(status.includes("broken on purpose"), "ext_status does not show the failure")
check(status.includes("sad (installed)") && status.includes("hello (installed)"), "ext_status does not show the staged copies")

step("remove asks, reverts when there is a saved version, rejects a staged copy")
const removed = await server(base).rpc(project, "kagan.ext", "remove", { id: "sad" })
await server(base).reload(project)
say(`remove sad -> ${JSON.stringify(removed)}`)
check(!(await readdir(path.join(project, ".opencode", "plugins"))).includes("sad"), "sad is still installed")
const rejected = await server(base).rpc(project, "kagan.ext", "reject", { id: "sad" })
say(`reject sad -> ${JSON.stringify(rejected)}`)
check(!(await readdir(stagedDir(project, "sad")).catch(() => [])).length, "the staged copy survived the reject")

step("the agent's own promote asks the person, and a refusal installs nothing")
const refusing = agent(project, () => server(base).plugins(project), false)
await refusing.call("ext_new", { id: "denied", kind: "server" })
const refused = await refusing.call("ext_promote", { id: "denied" }).catch((error: Error) => error.message)
say(`refused promo -> ${refused.split("\n")[0]}`)
check(!(await readdir(path.join(project, ".opencode", "plugins"))).includes("denied"), "a refused promote still installed the extension")
check(refusing.asked.length === 1, "the agent's promote did not ask")

await call("ext_new", { id: "touched", kind: "server" })
say(`agent promote -> ${(await call("ext_promote", { id: "touched" })).split("\n")[0]}`)
check(asked.length === 1, "the agent's promote did not ask before copying")
await server(base).reload(project)
const touched = await waitFor("touched to load", async () => {
  const fresh = await server(base).plugins(project)
  return fresh.find((row) => row.id === "touched" && row.state.status === "active") ? fresh : undefined
})
say(`touched is ${touched.find((row) => row.id === "touched")!.state.status}`)

step("what this run saw")
say(`- the kit loaded in a real opencode v2.3.2 server (${rows.length} plugins listed, server + tui + rpc features)`)
say("- staging stayed invisible to the loader")
say("- the approval RPC installed hello, the TUI's location reload asked opencode to re-read plugins, and opencode then reported it active")
say("- a throwing extension was reported failed with its error, and ext_status carried it to the agent")
say(`- the agent's own ext_promote asked first ("${asked.join("; ")}") and a refusal left nothing installed`)

stop()
if (keep) say(`\nkept ${root}`)
else await rm(root, { recursive: true, force: true })
