import { expect, test } from "bun:test"
import { diffLines } from "../src/diff.ts"
import { guard, type Evaluation } from "../src/guard.ts"

const project = "/work/app"

const evaluate = (action: string, resources: string[], effect: Evaluation["effect"] = "allow"): Evaluation => ({
  action,
  resources,
  effect,
})

test("a write into the plugins folder becomes a question", () => {
  const event = evaluate("edit", ["/work/app/.opencode/plugins/x/index.ts"])
  guard(project, event)
  expect(event.effect).toBe("ask")
  expect(event.message).toContain("full rights")
})

test("a relative plugin path is caught too", () => {
  const event = evaluate("edit", [".opencode/plugins/x/index.ts"])
  guard(project, event)
  expect(event.effect).toBe("ask")
})

test("edits elsewhere and a configured deny are left alone", () => {
  const source = evaluate("edit", ["/work/app/src/index.ts"])
  guard(project, source)
  expect(source.effect).toBe("allow")

  const denied = evaluate("edit", ["/work/app/.opencode/plugins/x/index.ts"], "deny")
  guard(project, denied)
  expect(denied.effect).toBe("deny")
  expect(denied.message).toBeUndefined()
})

test("a shell command that writes into plugins becomes a question", () => {
  for (const command of [
    "echo hi > .opencode/plugins/x/index.ts",
    "cp /tmp/x.ts .opencode/plugins/x/index.ts",
    "rm -rf /work/app/.opencode/plugins/x",
    "mkdir -p .opencode/plugins/x",
  ]) {
    const event = evaluate("shell", [command])
    guard(project, event)
    expect(event.effect, command).toBe("ask")
  }
})

test("reading the folder or working elsewhere is not flagged", () => {
  for (const command of ["ls .opencode/plugins", "cat .opencode/plugins/x/index.ts", "git status", "echo hi > /tmp/x"]) {
    const event = evaluate("shell", [command])
    guard(project, event)
    expect(event.effect, command).toBe("allow")
  }
})

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
