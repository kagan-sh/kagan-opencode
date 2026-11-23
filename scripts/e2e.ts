#!/usr/bin/env bun
/**
 * End-to-end run in a throwaway project, with its own opencode config, data and
 * state dirs, so the person's real opencode is never touched.
 *
 * What it proves: the kit loads in a real opencode server; a staged extension
 * passes ext_check; the approval RPC installs the exact hashed content; a
 * changed hash is refused; opencode loads both a server and a TUI extension; a
 * failing extension shows up in ctx.plugin.list with its error; the real
 * permission path asks and a real rejection installs nothing; the page rejects
 * a staged copy from the keyboard; the audit trail reads back after the
 * reloads; ext_status reports both.
 *
 * What it cannot prove: the agent side of the loop needs a model, so the agent
 * tools are called directly here instead of through a session; the tools run
 * with their own storage, so the RPC's audit events reach the host's trail (read
 * here) and the tools' own reach ext_status. The permission step drives the
 * same server endpoint `ctx.permission.assert` uses; the wrapper itself is the
 * host's.
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

/**
 * The agent's tools, wired to a person who always says yes, as tests do. This
 * kit keeps its audit in memory, so it sees only the promotes it made itself:
 * in a real session one `ctx.storage` serves the tools and the RPC, and
 * `ext_status` shows both trails. The e2e reads the host's trail over the
 * snapshot RPC for the RPC side.
 */
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

const server = (base: string) => {
  const request = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...auth() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw new Error(`${method} ${url} failed: ${response.status} ${await response.text().catch(() => "")}`)
    return (await response.json().catch(() => ({}))) as T
  }

  return {
    plugins: async (location: string): Promise<PluginRow[]> => (await request<{ data: PluginRow[] }>("GET", `${base}/api/plugin?${where(location)}`)).data,
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
    /** Exactly what `ctx.permission.assert` posts, over the same endpoint. */
    permission: async (sessionID: string, action: string, resources: string[]) =>
      (
        await request<{ data: { id: string; effect: string } }>("POST", `${base}/api/session/${sessionID}/permission`, {
          action,
          resources,
          save: [],
        })
      ).data,
    permissionList: async (sessionID: string) =>
      (await request<{ data: { id: string; action: string; resources: string[] }[] }>("GET", `${base}/api/session/${sessionID}/permission`)).data,
    permissionReply: async (sessionID: string, requestID: string, decision: "once" | "always" | "reject", message: string) => {
      const response = await fetch(`${base}/api/session/${sessionID}/permission/${requestID}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth() },
        body: JSON.stringify({ decision, message }),
      })
      check(response.status === 204, `permission reply failed: ${response.status}`)
    },
    session: async (location: string) =>
      (await request<{ data: { id: string } }>("POST", `${base}/api/session?${where(location)}`, { title: "e2e permissions" })).data.id,
  }
}

/** The hash the person was shown, then the approval for exactly that hash. */
async function approve(base: string, location: string, id: string) {
  const diff = (await server(base).rpc(location, "kagan.ext", "diff", { id })) as { text: string; hash: string }
  return { diff, approved: await server(base).rpc(location, "kagan.ext", "approve", { id, hash: diff.hash }) }
}

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

step("the person approves it through the TUI's RPC (diff, approve)")
const hello = await approve(base, project, "hello")
check(hello.diff.text.includes(`hash ${hello.diff.hash}`), "the diff does not carry its hash")
say(`diff hash ${hello.diff.hash}; approve -> ${JSON.stringify(hello.approved)}`)
say(`installed at ${installedDir(project, "hello")}: ${(await readdir(installedDir(project, "hello"))).join(", ")}`)
check((hello.approved as { ok?: boolean }).ok === true, "approve did not report success")

step("a stale hash is refused, and nothing is installed")
await call("ext_new", { id: "drift", kind: "server" })
const drift = (await server(base).rpc(project, "kagan.ext", "diff", { id: "drift" })) as { hash: string }
await writeFile(
  path.join(stagedDir(project, "drift"), "index.ts"),
  'import { Plugin } from "@opencode/plugin"\nexport default Plugin.define({ id: "drift", setup() {} })\n// edited after the person looked\n',
)
const stale = (await server(base).rpc(project, "kagan.ext", "approve", { id: "drift", hash: drift.hash })) as { ok: boolean; message: string }
say(`approve with the old hash -> ${JSON.stringify(stale)}`)
check(stale.ok === false && stale.message.includes("changed since it was shown"), "a stale hash was not refused")
check(!(await readdir(path.join(project, ".opencode", "plugins"))).includes("drift"), "a stale hash still installed the extension")

step("the TUI reloads the location, and opencode loads it")
await server(base).reload(project)
for (const row of await server(base).plugins(project)) if (row.source.type === "local") say(`local plugin: ${JSON.stringify(row)}`)
const loaded = await waitFor("hello to load", async () => {
  const rows = await server(base).plugins(project)
  return rows.find((row) => row.id === "hello" && row.state.status === "active") ? rows : undefined
})
say(`hello is ${loaded.find((row) => row.id === "hello")!.state.status}`)

step("a TUI scaffold promotes and loads its tui.tsx (features.tui)")
say(await call("ext_new", { id: "panel", kind: "tui" }))
const panel = await approve(base, project, "panel")
say(`panel approve -> ${JSON.stringify(panel.approved)}`)
await server(base).reload(project)
const withPanel = await waitFor("panel to load", async () => {
  const fresh = await server(base).plugins(project)
  return fresh.find((row) => row.id === "panel" && row.state.status === "active") ? fresh : undefined
})
const panelRow = withPanel.find((row) => row.id === "panel") as { features?: { tui?: boolean } }
say(`panel is active, features: ${JSON.stringify(panelRow.features)}`)
check(panelRow.features?.tui === true, "opencode does not see the promoted TUI part")

step("a broken extension becomes visible to the agent")
await call("ext_new", { id: "sad", kind: "server" })
await writeFile(
  path.join(stagedDir(project, "sad"), "index.ts"),
  'import { Plugin } from "@opencode/plugin"\n\nexport default Plugin.define({\n  id: "sad",\n  setup() {\n    throw new Error("this extension is broken on purpose")\n  },\n})\n',
)
say(await call("ext_check", { id: "sad" }))
const sad = await approve(base, project, "sad")
check((sad.approved as { ok?: boolean }).ok === true, "approve of the broken extension failed")
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

step("the real permission path asks, and a real rejection installs nothing")
const sessionID = await server(base).session(project)
await call("ext_new", { id: "asked", kind: "server" })
const askedHash = ((await server(base).rpc(project, "kagan.ext", "diff", { id: "asked" })) as { hash: string }).hash
const evaluated = await server(base).permission(sessionID, "ext.promote", [`asked@${askedHash}`])
say(`permission effect for ext.promote under a default config: ${evaluated.effect}`)
check(evaluated.effect === "ask", "the guard did not turn ext.promote into a question")
const pending = await server(base).permissionList(sessionID)
const request = pending.find((item) => item.action === "ext.promote")
check(!!request, "no permission request was created")
say(`asked for ${request!.action} on ${request!.resources.join(", ")}`)
await server(base).permissionReply(sessionID, request!.id, "reject", "not this one")
check((await server(base).permissionList(sessionID)).every((item) => item.id !== request!.id), "the rejected request is still pending")
check(!(await readdir(path.join(project, ".opencode", "plugins"))).includes("asked"), "a rejected permission still installed the extension")
say("rejected: nothing installed")

step("the /extensions page in a real terminal (tmux, no model)")
const tui = await proofOfPage({ project, env })
say("--- /extensions ---")
say(tui.capture)
say("--- after x on the staged drift row ---")
say(tui.ask)
say(`staged drift after the TUI reject: ${(await readdir(stagedDir(project, "drift")).catch(() => [])).length ? "still there" : "gone"}`)
check(!(await readdir(stagedDir(project, "drift")).catch(() => [])).length, "the TUI's reject did not delete the staged copy")
if (tui.prompt) {
  say("--- after q, typed jkaq ---")
  say(tui.prompt.split("\n").filter((line) => line.includes("jkaq") || line.includes("Build")).join("\n"))
}

step("remove asks, reverts when there is a saved version, rejects a staged copy")
const removed = await server(base).rpc(project, "kagan.ext", "remove", { id: "sad" })
await server(base).reload(project)
say(`remove sad -> ${JSON.stringify(removed)}`)
check(!(await readdir(path.join(project, ".opencode", "plugins"))).includes("sad"), "sad is still installed")
const rejected = await server(base).rpc(project, "kagan.ext", "reject", { id: "sad" })
say(`reject sad -> ${JSON.stringify(rejected)}`)
check(!(await readdir(stagedDir(project, "sad")).catch(() => [])).length, "the staged copy survived the reject")

step("the host's audit trail reads back after the reloads")
const host = (await server(base).rpc(project, "kagan.ext", "snapshot", {})) as { audit: { action: string; id: string; via: string }[] }
say(`host audit (newest first): ${host.audit.map((event) => `${event.action} ${event.id} via ${event.via}`).join("; ")}`)
check(host.audit.some((event) => event.action === "promote" && event.via === "rpc"), "the host's audit does not show the RPC promotes")
check(host.audit.some((event) => event.action === "reject" && event.id === "drift" && event.via === "rpc"), "the TUI's reject is not in the host's audit")

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

step("ext_status shows the trail for the promotes it made itself")
const trail = await call("ext_status")
say(trail.split("\n").filter((line) => line.startsWith("recent") || line.startsWith("  ")).join("\n"))
check(trail.includes("promote touched via tool"), "ext_status does not show the agent's own promote")

step("what this run saw")
say(`- the kit loaded in a real opencode v2.3.2 server (${rows.length} plugins listed, server + tui + rpc features)`)
say("- staging stayed invisible to the loader")
say("- the approval RPC installed the exact hash it showed, and a hash from before an edit was refused")
say("- a promoted TUI extension loaded with features.tui")
say("- a throwing extension was reported failed with its error, and ext_status carried it to the agent")
say(`- a real permission evaluation for ext.promote asked (effect) and a real reject left nothing installed`)
say("- the /extensions page rendered in a real terminal, listed the failed extension, and gave the keys back to the prompt")
say("- x on a staged row asked, then deleted the staged copy in a real terminal")
say("- the host's snapshot carried the audit trail (RPC promote, reject) after the reloads; ext_status carried the tool promote")
say(`- the agent's own ext_promote asked first ("${asked.join("; ")}") and a refusal left nothing installed`)

stop()
if (keep) say(`\nkept ${root}`)
else await rm(root, { recursive: true, force: true })

/**
 * The cheapest proof the TUI page works: a real terminal, no model. Opens
 * `/extensions`, shows the failed extension, closes with `q`, then types into
 * the prompt to show the page's keys did not eat the letters.
 */
async function proofOfPage(input: { project: string; env: Record<string, string | undefined> }) {
  const has = await Bun.spawn(["tmux", "-V"], { stdout: "ignore", stderr: "ignore" }).exited
  if (has !== 0) return { capture: "(tmux is not installed; the page was not driven)", ask: "", prompt: "" }

  const name = `kagan-e2e-${port}`
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
  const command = Object.entries(input.env)
    .filter(([key]) => key.startsWith("XDG_"))
    .map(([key, value]) => `${key}=${shellQuote(value ?? "")}`)
    .join(" ")
  const session = Bun.spawn(["tmux", "new-session", "-d", "-s", name, "-x", "120", "-y", "40", "-c", input.project, `${command} opencode --standalone`], {
    stdout: "ignore",
    stderr: "inherit",
  })
  await session.exited

  const run = async (...args: string[]) => {
    await Bun.spawn(["tmux", ...args], { stdout: "ignore", stderr: "ignore" }).exited
  }
  const capture = async () => {
    const child = Bun.spawn(["tmux", "capture-pane", "-p", "-t", name], { stdout: "pipe", stderr: "ignore" })
    return (await new Response(child.stdout).text()).trim()
  }

  try {
    await Bun.sleep(12_000)
    // Text and Enter must be separate keystrokes: the completion needs a beat to open before Enter dispatches it.
    await run("send-keys", "-t", name, "-l", "/extensions")
    await Bun.sleep(1_500)
    await run("send-keys", "-t", name, "Enter")
    await Bun.sleep(3_000)
    const page = await capture()
    check(page.includes("Extensions"), "the /extensions page did not render:\n" + page)
    check(/sad failed:/.test(page), "the /extensions page does not show the failed extension:\n" + page)
    check(page.includes("installed  hello active"), "the /extensions page does not show the loaded extension:\n" + page)

    // `x` on the staged `drift` row must ask, then delete it: it must not open the read-only diff.
    await run("send-keys", "-t", name, "j")
    await Bun.sleep(500)
    await run("send-keys", "-t", name, "x")
    await Bun.sleep(1_500)
    const ask = await capture()
    check(/Reject drift\?/.test(ask), "x did not ask to reject the staged copy:\n" + ask)
    await run("send-keys", "-t", name, "Enter")
    await Bun.sleep(3_000)
    const after = await capture()
    check(!/^staged\s+drift\b/m.test(after), "the rejected row is still listed:\n" + after)

    // `q` closes the page; every letter after it must reach the prompt.
    await run("send-keys", "-t", name, "q")
    await Bun.sleep(1_500)
    await run("send-keys", "-t", name, "-l", "jkaq")
    await Bun.sleep(1_500)
    const prompt = await capture()
    check(prompt.includes("jkaq"), "the page's keys are still swallowing the prompt:\n" + prompt)
    return { capture: page, ask, prompt }
  } finally {
    await run("kill-session", "-t", name)
  }
}
