import { readdir } from "node:fs/promises"
import { check } from "./check.ts"
import { assertId, stagedDir, stagingRoot } from "./paths.ts"
import { scaffold, type Kind } from "./scaffold.ts"

interface PluginRow {
  readonly id?: string
  readonly source: unknown
  readonly state: { readonly status: "active" } | { readonly status: "failed"; readonly error: string }
}

export interface ToolDeps {
  readonly project: string
  readonly plugins: () => Promise<readonly PluginRow[]>
}

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
})

export function extensionTools(deps: ToolDeps) {
  return [
    {
      name: "ext_new",
      description: "Scaffold a new opencode extension into .opencode/staging/<id>. Nothing there runs until a person promotes it.",
      input: object({ id: { type: "string" }, kind: { type: "string", enum: ["server", "tui"] } }, ["id", "kind"]),
      execute: async (input: unknown) => {
        const { id, kind } = input as { id: string; kind: Kind }
        const made = await scaffold(deps.project, id, kind)
        return { content: `Created ${made.dir}\nFiles: ${made.files.join(", ")}\nNext: edit, then ext_check.` }
      },
    },
    {
      name: "ext_check",
      description: "Check a staged extension's shape. Runs no extension code. Returns a list of problems, or OK.",
      input: object({ id: { type: "string" } }, ["id"]),
      execute: async (input: unknown) => {
        const { id } = input as { id: string }
        const problems = await check(stagedDir(deps.project, id), assertId(id))
        return { content: problems.length ? problems.map((p) => `- ${p}`).join("\n") : "OK" }
      },
    },
    {
      name: "ext_status",
      description: "List staged extensions and which loaded plugins are active or failed, with the error.",
      input: object({}, []),
      execute: async () => {
        const staged = await readdir(stagingRoot(deps.project)).catch(() => [])
        const rows = (await deps.plugins()).map((p) =>
          p.state.status === "failed" ? `FAILED ${p.id ?? JSON.stringify(p.source)}: ${p.state.error}` : `active ${p.id ?? JSON.stringify(p.source)}`,
        )
        return { content: [`staged: ${staged.join(", ") || "none"}`, ...rows].join("\n") }
      },
    },
  ]
}
