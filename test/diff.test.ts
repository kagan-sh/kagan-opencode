import { expect, test } from "bun:test"
import { diffLines } from "../src/diff.ts"

test("the diff marks new files and changed lines", () => {
  expect(diffLines("", "a\nb")).toEqual(["+a", "+b"])
  expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([" a", "-b", "+B", " c"])
})

test("the diff collapses long unchanged runs", () => {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n")
  const after = `${before}\nlast`
  const lines = diffLines(before, after)
  expect(lines).toContain("+last")
  expect(lines.length).toBeLessThan(20)
  expect(lines).toContain(" ...")
})
