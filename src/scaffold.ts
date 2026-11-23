import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { assertId, stagedDir } from "./paths.ts"

export type Kind = "server" | "tui"

const server = (id: string) => `import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "${id}",
  async setup(ctx) {
    // One extension, one job. This example is a working starting point.
    await ctx.tool.transform((tools) =>
      tools.add({
        name: "${id}",
        description: "Describe what this does for the agent.",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        execute: async (input) => ({ content: String((input as { text: string }).text) }),
      }),
    )
  },
})
`

const tui = (id: string) => `import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "${id}.tui",
  setup(ctx) {
    return ctx.ui.slot({ append: "sidebar.footer", render: () => <text>${id}</text> })
  },
})
`

/** Templates only. A local plugin folder needs no package.json: root index.ts and tui.tsx are found. */
const templates = (id: string, kind: Kind): Record<string, string> => ({
  "index.ts": server(id),
  ...(kind === "tui" ? { "tui.tsx": tui(id) } : {}),
})

export async function scaffold(project: string, id: string, kind: Kind) {
  const dir = stagedDir(project, assertId(id))
  const files = templates(id, kind)
  await mkdir(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text, { flag: "wx" })
  return { dir, files: Object.keys(files) }
}
