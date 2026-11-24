import { readdir, rm } from "node:fs/promises"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { audit, type Audit, type AuditEvent } from "./audit.ts"
import { check } from "./check.ts"
import { diffLines } from "./diff.ts"
import { hashFiles, history, promote, remove as removeInstalled, revert as revertInstalled } from "./promote.ts"
import { inspect, type FileInfo } from "./inspect.ts"
import { idPattern, installedDir, pluginsRoot, stagedDir, stagingRoot } from "./paths.ts"

/** The parts of `ctx.plugin.list()` the kit reads. */
export interface PluginRow {
  readonly id?: string
  readonly source: { readonly type: string; readonly path?: string; readonly target?: string }
  readonly state: { readonly status: "active" } | { readonly status: "failed"; readonly error: string }
}

export interface Snapshot {
  readonly staged: readonly { id: string; installed: boolean }[]
  readonly installed: readonly { id: string; status: "active" | "failed" | "unknown"; error: string; revertable: boolean }[]
  readonly failed: readonly { label: string; error: string }[]
  readonly audit: readonly AuditEvent[]
}

export interface KitDeps {
  readonly project: string
  readonly plugins: () => Promise<readonly PluginRow[]>
  readonly storage: StorageDomain
  /**
   * Told after every change. The server part cannot reload a location, but the
   * TUI part can, so it hears this and reloads.
   */
  readonly onChange?: (change: { id: string; action: AuditEvent["action"] }) => Promise<void>
}

const directories = async (root: string) =>
  (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && idPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()

/** The whole change must fit in the approval text: a cut diff hides code a person installs. */
const shownLimit = 12_000

/** Characters a person has to read: the staged text itself, not the diff against an old copy. */
const stagedChars = (files: readonly FileInfo[]) => files.reduce((sum, file) => sum + (file.text?.length ?? 0), 0)

/** A load error arrives with a full stack; the first lines have the message and the file. */
const brief = (error: string) => error.split("\n").slice(0, 3).join("\n")

const refusal = (id: string, problems: readonly string[]) =>
  `refused: ${id} cannot be promoted\n${problems.map((problem) => `- ${problem}`).join("\n")}`

const sizes = (files: readonly FileInfo[]) =>
  files.map((file) => `  ${file.path}  ${file.bytes} B  sha256 ${file.hash}`)

export function createKit(deps: KitDeps) {
  const trail: Audit = audit(deps.storage)
  const { project } = deps
  const checkStaged = (id: string) => check(stagedDir(project, id), id)

  const snapshot = async (): Promise<Snapshot> => {
    const [stagedIds, installedIds, rows] = await Promise.all([
      directories(stagingRoot(project)),
      directories(pluginsRoot(project)),
      deps.plugins(),
    ])
    const byId = new Map(rows.filter((row) => row.id).map((row) => [row.id as string, row]))

    return {
      staged: stagedIds.map((id) => ({ id, installed: installedIds.includes(id) })),
      installed: await Promise.all(
        installedIds.map(async (id) => {
          const row = byId.get(id)
          return {
            id,
            status: row?.state.status ?? "unknown",
            error: row?.state.status === "failed" ? brief(row.state.error) : "",
            revertable: (await history(project, id)).length > 0,
          }
        }),
      ),
      failed: rows
        .filter((row) => row.state.status === "failed")
        .map((row) => ({
          label: row.id ?? row.source.path ?? row.source.target ?? "unknown plugin",
          error: row.state.status === "failed" ? brief(row.state.error) : "",
        })),
      audit: await trail.recent(5),
    }
  }

  /**
   * Everything a person needs to decide: what it is, what it touches, what
   * changes, and the hash of those exact bytes. Refuses rather than showing
   * less than the whole change. `patch` is the same change as one unified
   * diff hunk, the form opencode's permission dialog renders.
   */
  const describe = async (id: string): Promise<{ readonly text: string; readonly hash: string; readonly patch: string }> => {
    const inspection = await inspect(stagedDir(project, id), id)
    if (inspection.problems.length > 0) throw new Error(refusal(id, inspection.problems))

    // Measured on the staged files, so the same staged bytes are judged the same
    // whether or not an installed copy exists: a diff against an old copy repeats
    // the old lines, and that is not what the person has to read.
    const size = stagedChars(inspection.files)
    if (size > shownLimit)
      throw new Error(
        `refused: ${id} cannot be shown in full: its ${inspection.files.length} staged files are ${size} characters, and a person must read all of them before approving (limit ${shownLimit}). Split the extension into smaller ones.`,
      )

    const installed = await directories(pluginsRoot(project))
    const before = installed.includes(id) ? await inspect(installedDir(project, id), id).catch(() => undefined) : undefined
    const hash = await hashFiles(stagedDir(project, id), inspection.files.map((file) => file.path))

    const lines = [
      `extension ${id}  hash ${hash}`,
      `files (${inspection.files.length}):`,
      ...sizes(inspection.files),
      `contributions (regex hints): ${inspection.contributions.join(", ") || "none detected"}`,
      `imports: ${inspection.imports.join(", ") || "none"}`,
      "",
    ]

    for (const file of inspection.files) {
      const was = before?.files.find((old) => old.path === file.path)
      if (was?.hash === file.hash) {
        lines.push(`${file.path}: unchanged`, "")
        continue
      }
      lines.push(`${was ? "changed" : "new"} file ${file.path}`, ...diffLines(was?.text ?? "", file.text ?? ""), "")
    }

    const text = lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n")

    // One addition hunk: every staged line, with the file list and the hash as
    // the first lines. opencode's edit prompt renders this as a scrollable diff.
    const added = [
      `+extension ${id}  hash ${hash}`,
      `+files (${inspection.files.length}):`,
      ...inspection.files.map((file) => `+  ${file.path}  ${file.bytes} B  sha256 ${file.hash}`),
      `+contributions (regex hints): ${inspection.contributions.join(", ") || "none detected"}`,
      `+imports: ${inspection.imports.join(", ") || "none"}`,
      "+",
      ...inspection.files.flatMap((file) => [`+${file.path}:`, ...(file.text ?? "").split("\n").map((line) => `+${line}`)]),
    ]
    const patch = ["--- /dev/null", `+++ b/.opencode/plugins/${id}`, `@@ -0,0 +1,${added.length} @@`, ...added].join("\n")
    return { text, hash, patch }
  }

  const record = async (event: AuditEvent) => {
    await trail.record(event)
    await deps.onChange?.({ id: event.id, action: event.action })
  }

  /**
   * Installs the exact bytes that `hash` was computed from. A refusal leaves
   * staging and the installed copy untouched.
   */
  const approve = async (id: string, hash: string, via: AuditEvent["via"]) => {
    const shown = await describe(id)
    if (shown.hash !== hash)
      throw new Error(`refused: ${id} changed since it was shown (${hash} -> ${shown.hash}); look at it again before approving`)
    const problems = await checkStaged(id)
    if (problems.length > 0) throw new Error(refusal(id, problems))

    const promoted = await promote(project, id, shown.hash)
    await record({
      at: new Date().toISOString(),
      action: "promote",
      id,
      hash: promoted.hash,
      files: [...promoted.files],
      via,
      note: promoted.replaced ? "replaced an older installed version" : "",
    })
    return { files: promoted.files, hash: promoted.hash }
  }

  const reject = async (id: string, via: AuditEvent["via"]) => {
    await rm(stagedDir(project, id), { recursive: true, force: true })
    await record({ at: new Date().toISOString(), action: "reject", id, hash: "", files: [], via, note: "staged copy deleted" })
  }

  const remove = async (id: string, via: AuditEvent["via"]) => {
    const files = await removeInstalled(project, id)
    await record({ at: new Date().toISOString(), action: "remove", id, hash: "", files: [...files], via, note: "" })
    return files
  }

  const revert = async (id: string, via: AuditEvent["via"]) => {
    const restored = await revertInstalled(project, id)
    await record({
      at: new Date().toISOString(),
      action: "revert",
      id,
      hash: "",
      files: [...restored.files],
      via,
      note: `restored ${restored.stamp}`,
    })
    return restored
  }

  return {
    snapshot,
    describe,
    approve,
    reject,
    remove,
    revert,
    /// Lint plus typecheck, as ext_check reports it. Runs no extension code.
    check: checkStaged,
  }
}

export type Kit = ReturnType<typeof createKit>
