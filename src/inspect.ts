import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

const skipped = new Set(["node_modules", ".git", ".DS_Store"])
const entryFile = /^(index|server)\.(ts|js)$/
const sourceFile = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/
const defined = /Plugin\.define\(\s*\{[\s\S]{0,2000}?\bid:\s*["']([^"']+)["']/

/** One file in an extension, as the approval text shows it. */
export interface FileInfo {
  readonly path: string
  readonly bytes: number
  readonly hash: string
  /** Undefined when the file is not UTF-8 text: the kit cannot show it, so it cannot be approved. */
  readonly text?: string
}

/** A grep-level reading of an extension. Nothing here runs the code. */
export interface Inspection {
  readonly id: string
  readonly files: readonly FileInfo[]
  readonly contributions: readonly string[]
  readonly imports: readonly string[]
  readonly problems: readonly string[]
}

/** Regex hints, not a proof: an extension can hide any of these behind a string. */
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
  [/\bnode:fs\b|\bfrom\s+["']fs["']|\bBun\.(file|write|reader)\b/, "file access"],
  [/\bfetch\s*\(|\bnode:https?\b|\bBun\.(fetch|connect)\b/, "network"],
  [/\bnode:child_process\b|\bBun\.(spawn|spawnSync|\$)\b|\bDeno\.run\b/, "processes"],
  [/\bBun\./, "Bun APIs"],
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

/** Text, or undefined for a binary the approval text cannot show. */
const decode = (buffer: Buffer): string | undefined => {
  if (buffer.includes(0)) return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  } catch {
    return undefined
  }
}

const short = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex").slice(0, 12)

export async function inspect(dir: string, id: string): Promise<Inspection> {
  const empty = { id, files: [], contributions: [], imports: [] }
  if (!(await stat(dir).catch(() => undefined))) return { ...empty, problems: [`${dir} does not exist`] }

  let names: string[]
  try {
    names = await walkFiles(dir)
  } catch (error) {
    return { ...empty, problems: [error instanceof Error ? error.message : String(error)] }
  }

  const files: FileInfo[] = []
  const problems: string[] = []
  for (const name of names) {
    const buffer = await readFile(path.join(dir, name))
    const text = decode(buffer)
    if (text === undefined) problems.push(`${name}: not UTF-8 text, so the kit cannot show the whole file and cannot approve it`)
    files.push({ path: name, bytes: buffer.length, hash: short(buffer), ...(text === undefined ? {} : { text }) })
  }

  const entries = files.filter((file) => entryFile.test(file.path))
  if (entries.length === 0) problems.push("no index.ts: the server part needs one")
  for (const entry of entries) {
    const text = entry.text ?? ""
    if (text && !text.includes("Plugin.define(")) problems.push(`${entry.path}: export default Plugin.define({ id, setup })`)
    if (text && !/\bexport\s+default\b/.test(text)) problems.push(`${entry.path}: needs a default export`)
  }

  for (const file of files) {
    const text = file.text ?? ""
    const declared = defined.exec(text)?.[1] ?? (entryFile.test(file.path) ? /\bid:\s*["']([^"']+)["']/.exec(text)?.[1] : undefined)
    const own = declared?.replace(/\.tui$/, "")
    if (declared && own !== id) problems.push(`${file.path}: id is "${declared}", folder is "${id}"; they must match`)
  }

  const contributions = new Set<string>()
  const imports = new Set<string>()
  for (const file of files) {
    const text = file.text
    if (text === undefined || !sourceFile.test(file.path)) continue
    if (/from\s+["']@opencode-ai\/plugin/.test(text)) problems.push(`${file.path}: imports @opencode-ai/plugin (v1); use @opencode/plugin`)
    if (/from\s+["'][^"']*node_modules\/(effect|@opencode\/plugin)/.test(text))
      problems.push(`${file.path}: imports a bundled copy of effect or @opencode/plugin; use the kit's types`)
    for (const [pattern, label] of marks) if (pattern.test(text)) contributions.add(label)
    for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) imports.add(match[1]!)
  }

  return { id, files, contributions: [...contributions].sort(), imports: [...imports].sort(), problems }
}
