export interface SkillText {
  readonly id: string
  readonly description: string
  readonly content: string
}

export const skills: readonly SkillText[] = [
  {
    id: "ext-overview",
    description: "Extend opencode yourself: write, check and propose a plugin. Use when the user asks for a new tool, command, hook, panel or rule.",
    content: `# Extend opencode

A plugin is a folder with \`index.ts\` (server part) and optionally \`tui.tsx\` (terminal UI part).

Loop:
1. \`ext_new { id, kind }\` scaffolds into \`.opencode/staging/<id>\`. Nothing there runs.
2. Edit the files with your edit tools. Load \`ext-server\` or \`ext-tui\` for the API.
3. \`ext_check { id }\` checks the shape. Fix every problem it lists.
4. Ask the person to promote it. Never copy into \`.opencode/plugins\` yourself: code there runs at once with their full rights.
5. \`ext_status\` shows which plugins loaded or failed, and why.

Rules: import only from \`@opencode/plugin\` (never \`@opencode-ai/plugin\`, that is v1). The \`id\` in \`Plugin.define\` equals the folder name. Keep one extension to one job.`,
  },
  {
    id: "ext-server",
    description: "Server-side plugin API: tools, slash commands, skills, hooks, events. Load before writing index.ts.",
    content: `# Server plugin API (\`@opencode/plugin\` 2.x)

\`\`\`ts
import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "my-ext",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => tools.add({
      name: "hello", description: "Say hello",
      input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      execute: async (input) => ({ content: "Hello " + (input as { name: string }).name }),
    }))
    await ctx.command.transform((c) => c.add({ name: "hi", description: "Greet", execute: async ({ sessionID, prompt, delivery }) => {
      await ctx.session.prompt({ ...prompt, sessionID, text: "Say hi", delivery })
    } }))
    await ctx.tool.hook("execute.before", (event) => { /* throw to block */ })
    return () => { /* cleanup */ }
  },
})
\`\`\`

Also: \`ctx.skill.transform\`, \`ctx.agent.transform\`, \`ctx.mcp.transform\`, \`ctx.session.hook("context", e => e.system.push(...))\`, \`ctx.permission.hook("evaluate")\`, \`ctx.event.subscribe()\`, \`ctx.storage.get/set\`. Transform editors are synchronous: load data first. Full reference: the \`.d.ts\` files in \`node_modules/@opencode/plugin/src/promise/\`.`,
  },
  {
    id: "ext-tui",
    description: "Terminal UI plugin API: slots, routes, keys, dialogs. Load before writing tui.tsx.",
    content: `# TUI plugin API (\`@opencode/plugin/tui\`)

\`\`\`tsx
import { Plugin } from "@opencode/plugin/tui"
export default Plugin.define({
  id: "my-ext.tui",
  setup(ctx) {
    const off = ctx.ui.slot({ append: "sidebar.footer", render: () => <text>hello</text> })
    ctx.keymap.layer(() => ({ commands: [{ id: "my-ext.open", title: "Open", palette: true, run: () => ctx.ui.toast.show({ message: "hi" }) }] }))
    return off
  },
})
\`\`\`

Slots: app, home.footer, home.footer.status, prompt.footer, prompt.footer.status, prompt.footer.file, session.composer.top, sidebar.content, sidebar.footer, session.panel. Placement: prepend, append, before, after, replace. You cannot draw inside the message list. A TUI part lives in a folder with \`package.json\` exports \`./tui\`.`,
  },
]
