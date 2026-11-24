import { realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isInside, pluginsRoot } from "./paths.ts"

/** The mutable part of a permission decision, as the `evaluate` hook receives it. */
export interface Evaluation {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  effect: "allow" | "ask" | "deny"
  message?: string
}

/** The guard's reason, sent to the terminal UI: opencode 2.3.2 never renders `message`. */
export type Notice = (message: string) => void

/** Verbs and redirects that can put bytes on disk. Best effort, not a shell parser. */
const writes =
  /\b(cp|mv|rsync|install|ln|tee|unlink|truncate|touch|mkdir|rm|dd|patch|sed|perl|python|node|bun|tar|unzip)\b|(?<![0-9&])>>?|\bgit\s+(?:checkout|restore|clean|reset|switch)\b/

/** Programs that can reach the RPC. A mention alone is not a call. */
const clients = /\b(curl|wget|nc|ncat|http|https|fetch|axios|urllib|requests|bun|node|deno|python)\b/

/**
 * A shell line with quotes, string concatenation and redirects to `/dev/null`
 * removed: enough to see `"$u"/rpc` and `plug*` without a shell parser.
 */
const flatten = (command: string) =>
  command
    .replaceAll(/\d*>>?\s*\/dev\/null/g, "")
    .replaceAll(/["']/g, "")
    .replaceAll("+", "")

const callsRpc = (command: string) => {
  const flat = flatten(command)
  if (!clients.test(flat)) return false
  return /\bapi[\\/]rpc\b/.test(flat) || /\bkagan\.ext\b/.test(flat) || (/\brpc\b/.test(flat) && /kagan/.test(flat))
}

const namesPlugins = (project: string, command: string) => {
  const flat = flatten(command)
  return (
    flat.includes(`${pluginsRoot(project).replaceAll("\\", "/")}/`) ||
    /\.opencode[\\/]plugins\b/.test(flat) ||
    (flat.includes(".opencode") && /\bplug/.test(flat))
  )
}

/** Where opencode keeps the plugins and config that decide what runs. */
const configDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")

/**
 * The real path of `target`, or of its nearest existing parent plus the tail:
 * macOS makes `/var/x` and `/private/var/x` two names for one folder, and a
 * symlinked parent does the same.
 */
async function canonical(target: string): Promise<string> {
  let current = path.resolve(target)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      tail.push(path.basename(current))
      current = parent
    }
  }
}

const installMessage =
  "This puts extension code where opencode runs it at once with your full rights. Stage it with ext_new and promote it instead."
const rpcMessage =
  "This touches the kit's approval RPC. Any local process can call that RPC to install extension code; approve only what you have read."
const promoteMessage = "This installs the extension whose whole change and hash are in the dialog. Approve only if you have read it."

/**
 * Turns a write into a plugin folder, a change to the config that decides what
 * loads, or a call to the kit's own RPC into a question for the person. A deny
 * is left alone. The kit cannot sandbox the result, it can only make the
 * common paths noisy.
 */
export async function guard(project: string, event: Evaluation, notice?: Notice): Promise<void> {
  if (event.effect === "deny") return

  const raise = (message: string) => {
    event.effect = "ask"
    event.message = message
    // The prompt renders the action, not the reason; the toast carries the reason.
    notice?.(message)
  }

  // The person's rules may allow an unknown action outright; the kit always asks.
  if (event.action.startsWith("ext.")) {
    raise(installMessage)
    return
  }

  if (event.action === "edit") {
    // The kit's own promote asks as an edit of the target, so the dialog can render the diff.
    if (event.metadata?.kit === "promote") {
      raise(promoteMessage)
      return
    }
    const realProject = await canonical(project)
    const watched = await Promise.all(
      [
        pluginsRoot(realProject),
        path.join(realProject, "opencode.json"),
        path.join(realProject, "opencode.jsonc"),
        path.join(realProject, "tui.json"),
        path.join(realProject, ".opencode", "opencode.json"),
        path.join(realProject, ".opencode", "opencode.jsonc"),
        path.join(realProject, ".opencode", "tui.json"),
        path.join(realProject, ".opencode", "package.json"),
        path.join(configDir(), "plugins"),
        path.join(configDir(), "opencode.json"),
        path.join(configDir(), "opencode.jsonc"),
        path.join(configDir(), "cli.json"),
        path.join(configDir(), "tui.json"),
      ].map(canonical),
    )
    const targets = await Promise.all(event.resources.map((resource) => canonical(path.resolve(project, resource))))
    if (targets.some((target) => watched.some((root) => isInside(root, target)))) raise(installMessage)
    return
  }

  if (event.action === "shell") {
    if (event.resources.some((command) => callsRpc(command))) {
      raise(rpcMessage)
      return
    }
    if (event.resources.some((command) => namesPlugins(project, command) && writes.test(flatten(command)))) raise(installMessage)
  }
}
