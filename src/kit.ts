import { readdir, rm } from "node:fs/promises"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { audit, type Audit, type AuditEvent } from "./audit.ts"
import { check } from "./check.ts"
import { diffLines } from "./diff.ts"
import { inspect } from "./inspect.ts"
import { idPattern, installedDir, pluginsRoot, stagedDir, stagingRoot } from "./paths.ts"
import { history, promote, remove as removeInstalled, revert as revertInstalled } from "./promote.ts"

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

const limit = 200

/** A load error arrives with a full stack; the first lines have the message and the file. */
const brief = (error: string) => error.split("\n").slice(0, 3).join("\n")

export function createKit(deps: KitDeps) {
  const trail: Audit = audit(deps.storage)
  const { project } = deps

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

  /** Everything a person needs to decide: what it is, what it touches, what changes. */
  const describe = async (id: string) => {
    const inspection = await inspect(stagedDir(project, id), id)
    const installed = await directories(pluginsRoot(project))
    const before = installed.includes(id) ? await inspect(installedDir(project, id), id).catch(() => undefined) : undefined

    const lines = [
      `extension ${id}`,
      `files: ${inspection.files.join(", ") || "none"}`,
      `contributions: ${inspection.contributions.join(", ") || "none detected"}`,
      `imports: ${inspection.imports.join(", ") || "none"}`,
      inspection.problems.length
        ? `problems:\n${inspection.problems.map((problem) => `  - ${problem}`).join("\n")}`
        : "problems: none",
      "",
    ]

    for (const file of inspection.files) {
      const after = inspection.sources.get(file)
      if (after === undefined) {
        lines.push(`${file}: copied as is`, "")
        continue
      }
      const was = before?.sources.get(file)
      lines.push(was === undefined ? `new file ${file}` : `changed file ${file}`, ...diffLines(was ?? "", after), "")
    }

    const text = lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n")
    const rows = text.split("\n")
    return rows.length > limit ? `${rows.slice(0, limit).join("\n")}\n... (truncated)` : text
  }

  const record = async (event: AuditEvent) => {
    await trail.record(event)
    await deps.onChange?.({ id: event.id, action: event.action })
  }

  const approve = async (id: string, via: AuditEvent["via"]) => {
    const inspection = await inspect(stagedDir(project, id), id)
    if (inspection.problems.length > 0)
      throw new Error(`refused: ${id} has problems\n${inspection.problems.map((problem) => `- ${problem}`).join("\n")}`)

    const promoted = await promote(project, id)
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
    check: (id: string) => check(stagedDir(project, id), id),
  }
}

export type Kit = ReturnType<typeof createKit>
