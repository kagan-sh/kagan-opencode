import type { Kit } from "./kit.ts"
import { assertId } from "./paths.ts"
import type { WireReply } from "./rpc.ts"

const idOf = (input: unknown) => assertId((input as { id?: unknown } | undefined)?.id)

/** Approval is bound to the bytes the person was shown, so the hash must be the one `diff` returned. */
const hashOf = (input: unknown) => {
  const hash = (input as { hash?: unknown } | undefined)?.hash
  if (typeof hash !== "string" || !/^[0-9a-f]{12}$/.test(hash))
    throw new Error("approve needs the 12-character content hash that diff returned")
  return hash
}

/** The RPC methods, kept apart from the plugin so a test can call them. */
export function handlers(kit: Kit) {
  const reply = async (act: () => Promise<string>): Promise<WireReply> => {
    try {
      return { ok: true, message: await act() }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    snapshot: () => kit.snapshot(),
    diff: async (input: unknown) => kit.describe(idOf(input)),
    approve: async (input: unknown) =>
      reply(async () => {
        const id = idOf(input)
        const promoted = await kit.approve(id, hashOf(input), "rpc")
        return `promoted ${id} (${promoted.files.join(", ")}), hash ${promoted.hash}`
      }),
    reject: async (input: unknown) =>
      reply(async () => {
        const id = idOf(input)
        await kit.reject(id, "rpc")
        return `rejected ${id}; the staged copy is gone`
      }),
    remove: async (input: unknown) =>
      reply(async () => {
        const id = idOf(input)
        return `removed ${id}, ${(await kit.remove(id, "rpc")).length} files`
      }),
    revert: async (input: unknown) =>
      reply(async () => {
        const id = idOf(input)
        return `reverted ${id} to ${(await kit.revert(id, "rpc")).stamp}`
      }),
  }
}
