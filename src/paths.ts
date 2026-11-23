import path from "node:path"

/** Extension ids name folders, so keep them to one safe path segment. */
export const idPattern = /^[a-z][a-z0-9-]{1,39}$/

export function assertId(id: unknown): string {
  if (typeof id !== "string" || !idPattern.test(id))
    throw new Error(`extension id must be 2-40 chars: lowercase letters, digits and dashes, starting with a letter (got ${JSON.stringify(id)})`)
  return id
}

const inProject = (project: string, ...rest: string[]) => path.join(project, ".opencode", ...rest)

/** Where the agent writes. opencode does not load anything from here. */
export const stagingRoot = (project: string) => inProject(project, "staging")
export const stagedDir = (project: string, id: string) => path.join(stagingRoot(project), assertId(id))

/** Where opencode loads plugins from. Code here runs at once. */
export const pluginsRoot = (project: string) => inProject(project, "plugins")
export const installedDir = (project: string, id: string) => path.join(pluginsRoot(project), assertId(id))

/** Every version that was replaced by a promote or a revert. */
export const historyRoot = (project: string, id: string) => path.join(stagingRoot(project), ".history", assertId(id))

/** On-disk copy of the kit's own skills, so their `path` is real. */
export const skillsRoot = (project: string) => inProject(project, "ext-kit", "skills")

/** True when `target` is `root` or inside it; both may be relative to `project`. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** True when a resource an agent is about to touch is a plugin folder. */
export const isPluginPath = (project: string, resource: string) =>
  isInside(pluginsRoot(project), path.resolve(project, resource))
