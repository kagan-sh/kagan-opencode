import type { WireSnapshot } from "./rpc.ts"

/** One line on the extensions page. */
export type Item =
  | { readonly kind: "staged"; readonly id: string; readonly installed: boolean }
  | {
      readonly kind: "installed"
      readonly id: string
      readonly status: string
      readonly error: string
      readonly revertable: boolean
    }
  | { readonly kind: "failed"; readonly id: string; readonly error: string }

const first = (text: string) => text.split("\n")[0] ?? ""

export const items = (snapshot: WireSnapshot | undefined): Item[] => {
  if (!snapshot) return []
  const installed = snapshot.installed.map((item) => ({ kind: "installed" as const, ...item }))
  // A failed plugin need not be one the kit installed: list every failure the host reports.
  const failed = snapshot.failed
    .filter((item) => !snapshot.installed.some((row) => row.id === item.label))
    .map((item) => ({ kind: "failed" as const, id: item.label, error: item.error }))
  return [...snapshot.staged.map((item) => ({ kind: "staged" as const, ...item })), ...installed, ...failed]
}

export const label = (item: Item) => {
  if (item.kind === "staged") return `staged     ${item.id}${item.installed ? " (installed)" : ""}`
  if (item.kind === "failed") return `failed     ${item.id}: ${first(item.error)}`
  return `installed  ${item.id} ${item.status}${item.error ? `: ${first(item.error)}` : ""}`
}

/** Every key that acts on a row. */
export type Verb = "diff" | "approve" | "reject" | "remove" | "revert"

/**
 * Whether a verb can act on a row. Reading (`diff`) and rejecting need a staged
 * copy: an installed row has nothing staged to read, so `diff` would only fail.
 */
export const can = (verb: Verb, item: Item | undefined) => {
  if (verb === "remove" || verb === "revert") return item?.kind === "installed" && (verb === "revert" ? item.revertable : true)
  return item?.kind === "staged"
}
