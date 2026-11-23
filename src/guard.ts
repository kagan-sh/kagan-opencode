import { realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isInside, pluginsRoot } from "./paths.ts"

/** The mutable part of a permission decision, as the `evaluate` hook receives it. */
export interface Evaluation {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  effect: "allow" | "ask" | "deny"
  message?: string
}

/** Verbs and redirects that can put bytes on disk. Best effort, not a shell parser. */
const writes = /\b(cp|mv|rsync|install|ln|tee|unlink|truncate|touch|mkdir|rm|dd|patch|sed|perl|python|node|bun)\b|>>?/

/** The approval RPC and the kit's action namespace, reachable by any local process with a shell. */
const reachesRpc = /\bapi\/rpc\b|\bkagan\.ext\b/

const namesPlugins = (project: string, command: string) =>
  command.includes(`${pluginsRoot(project).replaceAll("\\", "/")}/`) ||
  /\.opencode[\\/]plugins\b/.test(command) ||
  (/(^|[\s/"'])plugins\b/.test(command) && command.includes(".opencode"))

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

/**
 * Turns a write into a plugin folder, a change to the config that decides what
 * loads, or a call to the kit's own RPC into a question for the person. A deny
 * is left alone. The kit cannot sandbox the result, it can only make the
 * common paths noisy.
 */
export async function guard(project: string, event: Evaluation): Promise<void> {
  if (event.effect === "deny") return

  // The person's rules may allow an unknown action outright; the kit always asks.
  if (event.action.startsWith("ext.")) {
    event.effect = "ask"
    event.message = installMessage
    return
  }

  if (event.action === "edit") {
    const realProject = await canonical(project)
    const watched = await Promise.all(
      [
        pluginsRoot(realProject),
        path.join(realProject, "opencode.json"),
        path.join(realProject, "opencode.jsonc"),
        path.join(configDir(), "plugins"),
        path.join(configDir(), "opencode.json"),
        path.join(configDir(), "opencode.jsonc"),
      ].map(canonical),
    )
    const targets = await Promise.all(event.resources.map((resource) => canonical(path.resolve(project, resource))))
    if (targets.some((target) => watched.some((root) => isInside(root, target)))) {
      event.effect = "ask"
      event.message = installMessage
    }
    return
  }

  if (event.action === "shell") {
    if (event.resources.some((command) => reachesRpc.test(command))) {
      event.effect = "ask"
      event.message = rpcMessage
      return
    }
    if (event.resources.some((command) => namesPlugins(project, command) && writes.test(command))) {
      event.effect = "ask"
      event.message = installMessage
    }
  }
}
