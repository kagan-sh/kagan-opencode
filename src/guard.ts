import { isPluginPath, pluginsRoot } from "./paths.ts"

/** The mutable part of a permission decision, as the `evaluate` hook receives it. */
export interface Evaluation {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  effect: "allow" | "ask" | "deny"
  message?: string
}

/** Verbs and redirects that can put bytes on disk. Best effort, not a shell parser. */
const writes = /\b(cp|mv|rsync|install|ln|tee|unlink|truncate|touch|mkdir|rm|dd|patch|sed|perl|python|node|bun)\b|>>?/

const namesPlugins = (project: string, command: string) =>
  command.includes(`${pluginsRoot(project).replaceAll("\\", "/")}/`) ||
  /\.opencode[\\/]plugins\b/.test(command) ||
  (/(^|[\s/"'])plugins\b/.test(command) && command.includes(".opencode"))

/**
 * Turns a write into a plugin folder into a question for the person. A deny is
 * left alone, and nothing is promoted: the kit cannot sandbox code that lands
 * there, it can only make the common paths noisy.
 */
export function guard(project: string, event: Evaluation): void {
  if (event.effect === "deny") return
  const touches =
    event.action === "edit"
      ? event.resources.some((resource) => isPluginPath(project, resource))
      : event.action === "shell"
        ? event.resources.some((command) => namesPlugins(project, command) && writes.test(command))
        : false
  if (!touches || event.effect === "ask") return

  event.effect = "ask"
  event.message =
    "This writes into .opencode/plugins, where code runs at once with your full rights. Stage it with ext_new and promote it instead."
}
