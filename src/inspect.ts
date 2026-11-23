import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { assertId } from "./paths.ts"

const skipped = new Set(["node_modules", ".git", ".DS_Store"])
const entryFile = /^(index|server)\.(ts|js)$/
const sourceFile = /\.(ts|tsx|js|jsx)$/

/** A grep-level reading of an extension. Nothing here runs the code. */
export interface Inspection {
  readonly id: string
  readonly files: readonly string[]
  readonly sources: ReadonlyMap<string, string>
  readonly contributions: readonly string[]
  readonly imports: readonly string[]
  readonly problems: readonly string[]
}

const marks: readonly (readonly [RegExp, string])[] = [
  [/\bctx\.tool\.transform\b/, "tools"],
  [/\bctx\.command\.transform\b/, "commands"],
  [/\bctx\.skill\.transform\b/, "skills"],
  [/\bctx\.agent\.transform\b/, "agents"],
  [/\bctx\.mcp\.transform\b/, "MCP servers"],
  [/\bctx\.session\.hook\b/, "session hooks"],
  [/\bctx\.tool\.hook\b/, "tool hooks"],
  [/\bctx\.permission\.hook\b/, "permission hooks"],
  [/\bctx\.shell\.hook\b/, "shell hooks"],
  [/\bctx\.event\.subscribe\b/, "events"],
  [/\bctx\.rpc\.register\b/, "RPC"],
  [/\bctx\.storage\b/, "storage"],
  [/\bctx\.session\.(prompt|create|command|compact)\b/, "sessions"],
  [/\bctx\.ui\.slot\b/, "UI slots"],
  [/\bctx\.ui\.(router|panel|dialog|toast)\b/, "TUI screens"],
  [/\bctx\.keymap\.layer\b/, "keys and commands"],
  [/\bctx\.experimental\./, "experimental API"],
]

/** Relative paths of every regular file under `dir`, sorted. Symlinks are refused. */
export async function walkFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (current: string, prefix: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`${relative} is a symlink; extensions must be plain files`)
      if (entry.isDirectory()) await walk(full, relative)
      else if (entry.isFile()) found.push(relative)
    }
  }
  await walk(dir, "")
  return found.sort()
}

export async function inspect(dir: string, id: string): Promise<Inspection> {
  const empty = { id, files: [], sources: new Map<string, string>(), contributions: [], imports: [] }
  if (!(await stat(dir).catch(() => undefined))) return { ...empty, problems: [`${dir} does not exist`] }

  let files: string[]
  try {
    files = await walkFiles(dir)
  } catch (error) {
    return { ...empty, problems: [error instanceof Error ? error.message : String(error)] }
  }
  const sources = new Map<string, string>()
  for (const file of files.filter((name) => sourceFile.test(name))) sources.set(file, await readFile(path.join(dir, file), "utf8"))

  const problems: string[] = []
  const entry = files.find((name) => entryFile.test(name))
  if (!entry) problems.push("no index.ts: the server part needs one")
  const entryText = entry ? (sources.get(entry) ?? "") : ""
  if (entryText && !entryText.includes("Plugin.define(")) problems.push(`${entry}: export default Plugin.define({ id, setup })`)
  if (entryText && !/\bexport\s+default\b/.test(entryText)) problems.push(`${entry}: needs a default export`)

  const declared = /id:\s*["']([^"']+)["']/.exec(entryText)?.[1]
  const own = declared?.replace(/\.tui$/, "")
  if (declared && own !== id) problems.push(`${entry}: id is "${declared}", folder is "${id}"; they must match`)

  const contributions = new Set<string>()
  const imports = new Set<string>()
  for (const [name, text] of sources) {
    if (/from\s+["']@opencode-ai\/plugin/.test(text)) problems.push(`${name}: imports @opencode-ai/plugin (v1); use @opencode/plugin`)
    if (/from\s+["'][^"']*node_modules\/(effect|@opencode\/plugin)/.test(text))
      problems.push(`${name}: imports a bundled copy of effect or @opencode/plugin; use the host's`)
    for (const [pattern, label] of marks) if (pattern.test(text)) contributions.add(label)
    for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) imports.add(match[1]!)
  }

  assertId(id)
  return { id, files, sources, contributions: [...contributions].sort(), imports: [...imports].sort(), problems }
}
