import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { assertId, stagedDir } from "./paths.ts"

export type Kind = "server" | "tui"

const server = (id: string) => `import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "${id}",
  setup: async (ctx) => {
    // register tools, commands, skills or hooks here
  },
})
`

const tui = (id: string) => `import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "${id}.tui",
  setup: (ctx) => {
    // draw with ctx.ui.slot, ctx.ui.router, ctx.keymap
  },
})
`

const manifest = (id: string, kind: Kind) => ({
  name: `opencode-ext-${id}`,
  version: "0.0.0",
  type: "module",
  exports: kind === "tui" ? { ".": "./index.ts", "./tui": "./tui.tsx" } : { ".": "./index.ts" },
  dependencies: { "@opencode/plugin": "2.3.2" },
})

export async function scaffold(project: string, id: string, kind: Kind) {
  const dir = stagedDir(project, assertId(id))
  await mkdir(dir, { recursive: true })
  const files: Record<string, string> = { "index.ts": server(id), "package.json": JSON.stringify(manifest(id, kind), null, 2) + "\n" }
  if (kind === "tui") files["tui.tsx"] = tui(id)
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text, { flag: "wx" })
  return { dir, files: Object.keys(files) }
}
