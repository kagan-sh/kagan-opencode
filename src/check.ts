import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

const v1Import = /from\s+["']@opencode-ai\/plugin/
const bundledHost = /from\s+["'](effect|@opencode\/plugin)\/node_modules/

export async function check(dir: string, id: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => undefined)
  if (!entries) return [`${dir} does not exist`]
  if (!entries.includes("index.ts") && !entries.includes("index.js")) return ["no index.ts: the server part needs one"]
  const problems: string[] = []
  const sources = entries.filter((name) => /\.(ts|tsx|js)$/.test(name))
  for (const name of sources) {
    const text = await readFile(path.join(dir, name), "utf8")
    if (v1Import.test(text)) problems.push(`${name}: imports @opencode-ai/plugin (v1); use @opencode/plugin`)
    if (bundledHost.test(text)) problems.push(`${name}: imports a bundled copy of the host's effect or @opencode/plugin`)
  }
  const index = await readFile(path.join(dir, entries.includes("index.ts") ? "index.ts" : "index.js"), "utf8")
  if (!index.includes("Plugin.define")) problems.push("index.ts: default export must be Plugin.define({ id, setup })")
  const declared = /id:\s*["']([^"']+)["']/.exec(index)?.[1]
  if (declared !== id) problems.push(`index.ts: id is "${declared ?? "missing"}", folder is "${id}"; they must match`)
  return problems
}
