import type { PermissionDomain } from "@opencode/plugin/promise/permission"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import path from "node:path"
import { typeFolders } from "./check.ts"
import type { Kit } from "./kit.ts"
import { assertId } from "./paths.ts"
import { scaffold, type Kind } from "./scaffold.ts"

export interface ToolDeps {
  readonly kit: Kit
  readonly project: string
  readonly permission: Pick<PermissionDomain, "assert">
}

const object = (properties: Record<string, unknown>, required: readonly string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
})

const text = (content: string) => ({ content })

/** The `.d.ts` folders an extension should read. The kit's pin, not the host's. */
const types = () => {
  const folders = typeFolders()
  return folders
    ? `types (the kit's pin of @opencode/plugin 2.3.2): ${folders.promise} and ${folders.tui}`
    : "types: the kit's @opencode/plugin package was not found; read the docs instead"
}

/** What a promote asks for. opencode 2.3.2 renders a diff only for an `edit` action. */
export interface ApprovalRequest {
  readonly action: "edit"
  readonly resources: readonly string[]
  readonly save: readonly string[]
  readonly metadata: Record<string, unknown>
}

/**
 * The promote request: an edit of the loaded folder, so the dialog renders the
 * whole change, plus the hash of exactly those bytes. `save: []` keeps
 * "always" from covering any later content.
 */
export const promotionApproval = (id: string, shown: { readonly hash: string; readonly patch: string }): ApprovalRequest => ({
  action: "edit",
  resources: [path.join(".opencode", "plugins", id), `${id}@${shown.hash}`],
  save: [],
  metadata: { kit: "promote", diff: shown.patch },
})

/**
 * A person says yes. The kit cannot enforce it, so this is the only gate there
 * is. A decline gets a message the agent can act on: opencode's own error is
 * the same for a decline and a failure, which is why the agent used to retry.
 */
const ask = async (
  deps: ToolDeps,
  context: ToolContext,
  request: {
    readonly action: string
    readonly resources: readonly string[]
    readonly metadata?: Record<string, unknown>
  },
  declined: { readonly verb: string; readonly what: string },
) => {
  try {
    await deps.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
      action: request.action,
      resources: [...request.resources],
      save: [],
      metadata: request.metadata ?? {},
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const message = `the person declined ${declined.verb}; ${declined.what}. Do not retry, and do not start another one unless they ask. (${reason})`
    // Keep the rejection object: the host uses a plain rejection to end the step.
    if (error instanceof Error) {
      error.message = message
      throw error
    }
    throw new Error(message)
  }
}

export function extensionTools(deps: ToolDeps): Info[] {
  const { kit } = deps

  return [
    {
      name: "ext_new",
      description:
        "Scaffold a new opencode extension into .opencode/staging/<id>. Nothing there runs until a person promotes it.",
      input: object({ id: { type: "string" }, kind: { type: "string", enum: ["server", "tui"] } }, ["id", "kind"]),
      execute: async (input) => {
        const { id, kind } = input as { id: string; kind: Kind }
        const made = await scaffold(deps.project, id, kind)
        return text(
          [
            `created ${made.dir}`,
            `files: ${made.files.join(", ")}`,
            types(),
            "Edit the files, then ext_check. Nothing here runs until ext_promote.",
          ].join("\n"),
        )
      },
    },
    {
      name: "ext_check",
      description:
        "Check a staged extension: folder shape, ids, imports, then a typecheck against the kit's pinned @opencode/plugin 2.3.2 types. Runs no extension code.",
      input: object({ id: { type: "string" } }, ["id"]),
      execute: async (input) => {
        const problems = await kit.check(assertId((input as { id: string }).id))
        return text([problems.length ? problems.map((problem) => `- ${problem}`).join("\n") : "OK", types()].join("\n"))
      },
    },
    {
      name: "ext_status",
      description:
        "Staged and installed extensions, which server plugins failed and why, and the last changes made to extensions.",
      input: object({}, []),
      execute: async () => {
        const snapshot = await kit.snapshot()
        const lines = [
          `staged: ${snapshot.staged.map((item) => `${item.id}${item.installed ? " (installed)" : ""}`).join(", ") || "none"}`,
          `installed: ${snapshot.installed.map((item) => `${item.id} ${item.status}${item.error ? `: ${item.error}` : ""}`).join(", ") || "none"}`,
          `failed plugins: ${snapshot.failed.map((item) => `${item.label}: ${item.error}`).join("; ") || "none"}`,
          ...(snapshot.audit.length
            ? ["recent:", ...snapshot.audit.map((event) => `  ${event.at} ${event.action} ${event.id} via ${event.via} ${event.hash}`)]
            : ["recent: none"]),
        ]
        return text(lines.join("\n"))
      },
    },
    {
      name: "ext_promote",
      description:
        "Ask the person to approve a staged extension, then install exactly those bytes into .opencode/plugins/<id>. The approval is an edit of that folder, so opencode's dialog shows every file with its size and hash and the whole change; a change too large to show, or a file that is not UTF-8 text, is refused, not cut. A running terminal UI reloads by itself; otherwise restart opencode.",
      input: object({ id: { type: "string" } }, ["id"]),
      execute: async (input, context) => {
        const id = assertId((input as { id: string }).id)
        const shown = await kit.describe(id)
        await ask(
          deps,
          context,
          promotionApproval(id, shown),
          { verb: `to promote ${id}`, what: "nothing was installed" },
        )
        const promoted = await kit.approve(id, shown.hash, "tool")
        return text(
          [
            `promoted ${id} (${promoted.files.join(", ")}), hash ${promoted.hash}`,
            "Run ext_status to confirm it is active. A running terminal UI reloads by itself; otherwise restart opencode.",
          ].join("\n"),
        )
      },
    },
    {
      name: "ext_remove",
      description: "Ask the person, then delete an installed extension from .opencode/plugins. Staged and saved versions stay.",
      input: object({ id: { type: "string" } }, ["id"]),
      execute: async (input, context) => {
        const id = assertId((input as { id: string }).id)
        await ask(
          deps,
          context,
          { action: "ext.remove", resources: [id] },
          { verb: `to remove ${id}`, what: "nothing was removed" },
        )
        const files = await kit.remove(id, "tool")
        return text(`removed ${id} (${files.length} files). Saved versions are kept for ext_revert if one exists.`)
      },
    },
    {
      name: "ext_revert",
      description: "Ask the person, then swap an installed extension back to the newest saved version.",
      input: object({ id: { type: "string" } }, ["id"]),
      execute: async (input, context) => {
        const id = assertId((input as { id: string }).id)
        await ask(
          deps,
          context,
          { action: "ext.revert", resources: [id] },
          { verb: `to revert ${id}`, what: "nothing was changed" },
        )
        const restored = await kit.revert(id, "tool")
        return text(`reverted ${id} to ${restored.stamp}. Run ext_status to confirm it loaded.`)
      },
    },
  ]
}
