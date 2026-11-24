import { expect, test } from "bun:test"
import { can, failedLabel, items, label, why } from "../src/page.ts"
import type { WireSnapshot } from "../src/rpc.ts"

const snapshot: WireSnapshot = {
  staged: [
    { id: "draft", installed: false },
    { id: "hello", installed: true },
  ],
  installed: [
    { id: "hello", status: "active", error: "", revertable: true },
    { id: "old", status: "failed", error: "boom\nstack", revertable: false },
  ],
  failed: [
    { label: "hello", error: "ignored: it is installed" },
    { label: "stray", error: "boom" },
  ],
  audit: [],
}

const row = (kind: "staged" | "installed" | "failed", id: string) => items(snapshot).find((item) => item.kind === kind && item.id === id)

test("the list shows staged, installed and stray failures", () => {
  expect(items(snapshot).map(label)).toEqual([
    "staged     draft",
    "staged     hello (installed)",
    "installed  hello active",
    "installed  old failed: boom",
    "failed     stray: boom",
  ])
  expect(items(undefined)).toEqual([])
})

test("o reads only a staged row", () => {
  expect(can("diff", row("staged", "draft"))).toBe(true)
  expect(can("diff", row("installed", "hello"))).toBe(false)
  expect(can("diff", row("failed", "stray"))).toBe(false)
  expect(can("diff", undefined)).toBe(false)
})

test("reject needs a staged row; remove and revert need an installed one", () => {
  expect(can("reject", row("staged", "draft"))).toBe(true)
  expect(can("reject", row("installed", "hello"))).toBe(false)
  expect(can("remove", row("installed", "old"))).toBe(true)
  expect(can("remove", row("staged", "draft"))).toBe(false)
  expect(can("revert", row("installed", "old"))).toBe(false)
  expect(can("revert", row("installed", "hello"))).toBe(true)
})

test("the badge says it counts server plugins, not tui.json ones", () => {
  expect(failedLabel(1)).toBe("1 server plugin failed - /extensions")
  expect(failedLabel(2)).toBe("2 server plugins failed - /extensions")
})

test("a key that does nothing says why", () => {
  for (const verb of ["diff", "approve", "reject", "remove", "revert"] as const) {
    for (const item of items(snapshot)) {
      const message = why(verb, item)
      if (can(verb, item)) expect(message, `${verb} ${item.id}`).toBe("")
      else expect(message.length, `${verb} ${item.id}`).toBeGreaterThan(0)
    }
  }
  expect(why("diff", row("installed", "hello"))).toContain("only a staged copy")
  expect(why("revert", row("installed", "old"))).toContain("no saved version")
  expect(why("remove", row("staged", "draft"))).toContain("only an installed extension")
  expect(why("diff", undefined)).toBe("Nothing is selected.")
})
