import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** A throwaway project directory. */
export const project = () => mkdtemp(path.join(tmpdir(), "kagan-ext-"))

/** In-memory storage with the same ordering `scan` promises. */
export function memory(): StorageDomain {
  const values = new Map<string, Parameters<StorageDomain["set"]>[1]>()
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
    scan: async (options) => ({
      entries: [...values.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value })),
    }),
  } as StorageDomain
}
