import path from "node:path"

export const idPattern = /^[a-z][a-z0-9-]{1,39}$/

export function assertId(id: string) {
  if (!idPattern.test(id)) throw new Error(`extension id "${id}" must be 2-40 chars: lowercase letters, digits, dashes, starting with a letter`)
  return id
}

export const stagingRoot = (project: string) => path.join(project, ".opencode", "staging")
export const stagedDir = (project: string, id: string) => path.join(stagingRoot(project), assertId(id))
