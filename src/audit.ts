import type { StorageDomain } from "@opencode/plugin/promise/storage"

/** JSON, as the storage domain takes it. */
type Json = Parameters<StorageDomain["set"]>[1]

const prefix = "ext-kit/audit/"

export type AuditEvent = {
  at: string
  action: "promote" | "reject" | "remove" | "revert"
  id: string
  hash: string
  files: string[]
  via: "tool" | "tui"
  note: string
}

export interface Audit {
  record(event: AuditEvent): Promise<void>
  recent(limit?: number): Promise<AuditEvent[]>
}

const read = (value: Json): AuditEvent | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const event = value as Record<string, unknown>
  if (typeof event.at !== "string" || typeof event.id !== "string") return undefined
  const action = event.action
  if (action !== "promote" && action !== "reject" && action !== "remove" && action !== "revert") return undefined
  return {
    at: event.at,
    action,
    id: event.id,
    hash: typeof event.hash === "string" ? event.hash : "",
    files: Array.isArray(event.files) ? event.files.map(String) : [],
    via: event.via === "tui" ? "tui" : "tool",
    note: typeof event.note === "string" ? event.note : "",
  }
}

/**
 * Who changed which extension, with its content hash. Kept in the host's storage
 * so it survives restarts and hot reloads.
 */
export function audit(storage: StorageDomain): Audit {
  // Keys sort in write order, even within one millisecond.
  let counter = 0
  const key = (at: string) => `${prefix}${at}-${(counter++).toString(36).padStart(6, "0")}`

  return {
    record: async (event) => {
      await storage.set(key(event.at), event)
    },
    recent: async (limit = 5) => {
      const { entries } = await storage.scan({ prefix, limit: 200 })
      return entries
        .sort((left, right) => right.key.localeCompare(left.key))
        .map((entry) => read(entry.value))
        .filter((event): event is AuditEvent => !!event)
        .slice(0, limit)
    },
  }
}
