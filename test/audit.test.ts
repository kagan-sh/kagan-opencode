import { expect, test } from "bun:test"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { audit, type AuditEvent } from "../src/audit.ts"

/** Storage that pages three keys at a time, like the host's `scan`. */
function paging(): StorageDomain {
  const values = new Map<string, Parameters<StorageDomain["set"]>[1]>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    scan: async (options) => {
      const keys = [...values.keys()].filter((key) => key.startsWith(options.prefix)).sort()
      const rest = options.after ? keys.filter((key) => key > options.after!) : keys
      const page = rest.slice(0, Math.min(options.limit ?? 3, 3))
      const next = rest.length > page.length ? page.at(-1) : undefined
      return {
        entries: page.map((key) => ({ key, value: values.get(key)! })),
        ...(next ? { next } : {}),
      }
    },
  } as StorageDomain
}

const event = (at: string, id: string): AuditEvent => ({
  at,
  action: "promote",
  id,
  hash: "0123456789ab",
  files: ["index.ts"],
  via: "tool",
  note: "",
})

test("recent reads past the first storage page", async () => {
  const trail = audit(paging())
  for (let index = 0; index < 10; index++) await trail.record(event(`2026-01-01T00:00:0${index}.000Z`, `e${index}`))

  const recent = await trail.recent(3)
  expect(recent.map((item) => item.id)).toEqual(["e9", "e8", "e7"])
})
