import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { walkFiles } from "./inspect.ts"
import { historyRoot, installedDir, pluginsRoot, stagedDir, temporaryRoot } from "./paths.ts"

const exists = async (target: string) => !!(await stat(target).catch(() => undefined))

/** Sortable by name: time first, then a counter for versions saved in the same millisecond. */
let counter = 0
const stamp = () => `${Date.now()}-${(counter++).toString(36).padStart(4, "0")}`

async function copyTree(from: string, to: string, files: readonly string[]) {
  for (const file of files) {
    const destination = path.join(to, file)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.join(from, file), destination)
  }
}

/** Content hash shown in the approval text, checked before the install, and kept in the audit trail. */
export async function hashFiles(dir: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256")
  for (const file of [...files].sort()) hash.update(file).update("\0").update(await readFile(path.join(dir, file)))
  return hash.digest("hex").slice(0, 12)
}

/** Saved versions for an extension, oldest first. */
export async function history(project: string, id: string): Promise<string[]> {
  const names = await readdir(historyRoot(project, id)).catch(() => [] as string[])
  return names.sort()
}

export interface Promotion {
  readonly files: readonly string[]
  readonly hash: string
  readonly replaced?: string
}

/**
 * Copies a staged extension into the plugins folder, where the watcher loads it
 * at once. The version it replaces is kept for `revert`.
 *
 * `expected` is the hash a person was shown. The copy is hashed before the
 * rename, so bytes that changed after the approval never reach the plugins
 * folder. Approval is the caller's job: this function only touches files.
 */
export async function promote(project: string, id: string, expected: string): Promise<Promotion> {
  const from = stagedDir(project, id)
  const files = await walkFiles(from)
  if (files.length === 0) throw new Error(`${from} is empty`)

  // Under staging, not plugins: a dot-folder next to loaded plugins is not worth the risk.
  const target = installedDir(project, id)
  const copy = path.join(temporaryRoot(project), `${id}-${stamp()}`)
  await mkdir(path.dirname(copy), { recursive: true })
  await copyTree(from, copy, files)

  const hash = await hashFiles(copy, files)
  if (hash !== expected) {
    await rm(copy, { recursive: true, force: true })
    throw new Error(`refused: ${id} changed after it was shown (${expected} -> ${hash}); look at it again before approving`)
  }

  let replaced: string | undefined
  let backup: string | undefined
  try {
    if (await exists(target)) {
      replaced = stamp()
      backup = path.join(historyRoot(project, id), replaced)
      await mkdir(path.dirname(backup), { recursive: true })
      await rename(target, backup)
    }
    await mkdir(pluginsRoot(project), { recursive: true })
    await rename(copy, target)
  } catch (error) {
    if (backup) await rename(backup, target).catch(() => undefined)
    await rm(copy, { recursive: true, force: true })
    throw error
  }

  return { files, hash, ...(replaced ? { replaced } : {}) }
}

/** Deletes the installed copy. Staging and history are untouched. */
export async function remove(project: string, id: string): Promise<readonly string[]> {
  const target = installedDir(project, id)
  if (!(await exists(target))) throw new Error(`${id} is not installed`)
  const files = await walkFiles(target).catch(() => [] as string[])
  await rm(target, { recursive: true, force: true })
  return files
}

/** Swaps the installed copy with the newest saved one. */
export async function revert(project: string, id: string): Promise<{ readonly stamp: string; readonly files: readonly string[] }> {
  const saved = await history(project, id)
  const newest = saved.at(-1)
  if (!newest) throw new Error(`${id} has no saved version to revert to`)

  const target = installedDir(project, id)
  if (await exists(target)) {
    const aside = path.join(historyRoot(project, id), stamp())
    await mkdir(path.dirname(aside), { recursive: true })
    await rename(target, aside)
  }
  await rename(path.join(historyRoot(project, id), newest), target)
  return { stamp: newest, files: await walkFiles(target).catch(() => [] as string[]) }
}
