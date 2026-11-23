import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { skillsRoot } from "./paths.ts"

export interface SkillText {
  readonly id: string
  readonly description: string
  readonly content: string
}

const docs = "https://opencode.ai/docs/build/plugins"

export const skills: readonly SkillText[] = [
  {
    id: "ext-overview",
    description:
      "How to add a tool, command, hook or UI part to this opencode with an extension. Load before writing one.",
    content: `# Extending opencode

An extension is a folder:

- \`index.ts\` - the server part (\`@opencode/plugin\`). Always needed.
- \`tui.tsx\` - the terminal UI part (\`@opencode/plugin/tui\`). Optional.
- \`rpc.ts\` - a typed contract between the two. Optional.

There is no package.json and no install step: opencode finds \`index.ts\` and \`tui.tsx\` at the folder root.

## The loop

1. \`ext_new { id, kind }\` writes \`.opencode/staging/<id>\`. **Nothing in staging ever runs.** It also prints the type folders to read.
2. Edit the files. Load \`ext-server\` for the server API and \`ext-tui\` for slots, routes and keys.
3. \`ext_check { id }\`: shape, ids, imports, and a typecheck against the kit's pinned \`@opencode/plugin\` 2.3.2 types. Fix every problem.
4. \`ext_promote { id }\`: shows the person every file with its size and hash and the whole diff, then installs exactly those bytes into \`.opencode/plugins/<id>\`. Over 12,000 characters of staged text is refused: split the extension.
5. \`ext_status\`: which plugins are active or failed, with the error, and what changed recently.
6. \`ext_remove\` / \`ext_revert\`: take it out, or go back to the version it replaced. Both ask.

If \`ext_status\` shows a failed extension, repair it in staging: edit the files, \`ext_check\` until it is clean, then \`ext_promote\` again. A promote replaces the installed copy and keeps the old one for \`ext_revert\`.

After a promote, opencode may not have re-read \`.opencode/plugins\`. A running terminal UI reloads by itself; otherwise restart opencode.

## Rules

- Import only from \`@opencode/plugin\`. \`@opencode-ai/plugin\` is v1 and does not run here.
- The \`id\` in \`Plugin.define\` equals the folder name. A TUI part may use \`<id>.tui\`.
- One extension, one job. Small is easier to review, to show in full, and to revert.
- Never copy into \`.opencode/plugins\` yourself. Promote instead: code there runs at once.
- Approval is a convention plus guards, not a sandbox: any local process that can reach opencode's API can approve, and a shell can write anywhere. Only plain UTF-8 text files can be approved, because the person must be able to read all of them.

Reference: \`${docs}\`, \`${docs}/server\`, \`${docs}/cli\`, \`${docs}/rpc\`.`,
  },
  {
    id: "ext-server",
    description: "Server extension API: tools, commands, skills, hooks, storage and RPC. Load before writing index.ts.",
    content: `# Server API (\`@opencode/plugin\` 2.x)

\`\`\`ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "my-ext",
  async setup(ctx) {
    await ctx.tool.transform((tools) =>
      tools.add({
        name: "my_tool",
        description: "What it does, for the agent.",
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        execute: async (input) => ({ content: String((input as { text: string }).text) }),
      }),
    )
    await ctx.command.transform((commands) =>
      commands.add({
        name: "my-command",
        description: "What it does",
        execute: async ({ sessionID, delivery, prompt }) => {
          // prompt.text holds what the person typed after the command name.
          await ctx.session.prompt({ sessionID, delivery, text: \`Do the thing: \${prompt.text}\` })
        },
      }),
    )
    return () => {
      // cleanup you own; registrations above are disposed with the plugin
    }
  },
})
\`\`\`

- Transforms are **synchronous**: read files or the network first, then edit inside the callback.
- Hooks: \`ctx.tool.hook("execute.before")\`, \`ctx.session.hook("context")\` (edit \`event.system\`), \`ctx.permission.hook("evaluate")\` (set \`event.effect\`), \`ctx.shell.hook("create.before")\`. Return a promise or throw to block.
- Other transforms: \`agent\`, \`skill\`, \`mcp\`, \`provider\`, \`model\`, \`integration\`. Read side: \`ctx.storage.get/set/scan\`, \`ctx.plugin.list()\`, \`ctx.session.*\`, \`ctx.event.subscribe()\`.
- Ask a person: \`ctx.permission.assert({ sessionID, action, resources, save: [] })\`. Do not assume a new action asks: on a default config an unknown action is allowed outright, so the kit's own guard turns every \`ext.*\` action into a question. Put the content hash in the resource (\`id@hash\`) so an "always" reply cannot cover new content, and pass \`save: []\` when it must not be saved.
- RPC: \`ctx.rpc.register(Definition, handlers)\`; see \`${docs}/rpc\`.

Types, which beat any summary here: the folders \`ext_new\` and \`ext_check\` print, \`dist/promise/*.d.ts\` for the server part and \`dist/tui/*.d.ts\` for the TUI part. They are the kit's own pinned copy (2.3.2), not the host's install. Docs: \`${docs}/server\`.`,
  },
  {
    id: "ext-tui",
    description: "TUI extension API: slots, routes, keymap commands, dialogs and storage. Load before writing tui.tsx.",
    content: `# TUI API (\`@opencode/plugin/tui\`)

\`\`\`tsx
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "my-ext.tui",
  setup(ctx) {
    const unregister = ctx.ui.router.register({
      name: "my-page",
      render: () => <text>Hello</text>,
    })
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "my-ext.open",
          title: "Open my page",
          palette: true,
          slash: { name: "my-page" },
          run: () => ctx.ui.router.navigate({ type: "plugin", name: "my-page" }),
        },
      ],
    }))
    const slot = ctx.ui.slot({ append: "sidebar.footer", render: () => <text>hi</text> })
    return () => {
      unregister()
      slot()
    }
  },
})
\`\`\`

- Slots: \`app\`, \`home.footer\`, \`home.footer.status\`, \`prompt.footer\`, \`prompt.footer.status\`, \`prompt.footer.file\`, \`session.composer.top\`, \`sidebar.content\`, \`sidebar.footer\`, \`session.panel\`. Placement: \`prepend\`, \`append\`, \`before\`, \`after\`, \`replace\`.
- There is no slot inside the message list, the header or the tab bar.
- \`ctx.ui.slot(...)\` and \`ctx.ui.router.register(...)\` return unregister functions: return them from \`setup\`.
- \`ctx.keymap.layer(factory)\` returns nothing; the layer goes away with the plugin or the component that created it.
- Dialogs: \`ctx.ui.dialog.confirm/alert/prompt/select\` (await them), \`ctx.ui.toast.show\`. State: \`ctx.storage.store/memory\`.
- Talk to the server part with \`ctx.client.rpc(Definition)\`, never by importing server code.
- The TUI loads \`tui.tsx\` beside \`index.ts\` automatically. \`solid-js\`, \`@opentui/solid\` and \`@opentui/core\` come from the host; do not bundle them.

Types: the \`dist/tui\` folder \`ext_new\` and \`ext_check\` print (the kit's pinned copy). Docs: \`${docs}/cli\`.`,
  },
  {
    id: "ext-safety",
    description: "What an opencode extension can do, what the kit guards and what it cannot. Load before promoting or asking for approval.",
    content: `# Safety

**An extension runs with the person's full rights.** It is not sandboxed: it can import \`node:fs\`, start processes, read credentials and make network calls, exactly as opencode itself can.

The kit's guards, and their limits:

- **Staging is not loading.** opencode only reads \`.opencode/plugins/\`, so staged code cannot run. This part is real.
- **Promote asks a person.** A tool call prompts for \`ext.promote\`; the TUI asks with a dialog. The approval is bound to a hash of the exact bytes shown, and the kit refuses to install anything that changed since. \`save: []\` means no "always" reply covers a later version. This is a convention: an agent with shell access can still write into \`.opencode/plugins\` itself. A permission hook turns that, a change to the config that loads plugins, and a call to the kit's RPC into a question, but shell inspection is best effort, so it can be missed.
- **The approval RPC is reachable by any local process.** \`reject\`, \`remove\`, \`revert\` and \`approve\` are plain HTTP calls on opencode's own API. An agent with a shell, or any other process that can reach the server, can \`curl\` them. The audit then says \`via: rpc\`. The kit cannot tell a person from a program there.
- **The audit trail** in opencode's storage records who promoted what, from where, with a content hash. It is a record, not a lock.
- **\`ext_check\` proves shape and types, not behaviour.** It never runs the extension.
- **Only plain UTF-8 text can be approved.** A binary or a file the kit cannot decode is refused, because the person must be able to read all of it. The whole diff must fit in the approval text; a bigger extension is refused, not cut.

What to tell the person before they approve:

1. What the extension touches: tools, commands, hooks, files, network, processes. The kit's list is a regex hint, not a proof.
2. What new authority it has: a hook that edits messages or blocks tools is more powerful than a read-only command.
3. How to undo it: \`ext_remove\`, or \`ext_revert\` to go back to the saved version.

What to do in the extension:

- Import only what you need. No bundled copies of \`effect\` or \`@opencode/plugin\`.
- Never read or print secrets, and never send data anywhere the person did not ask for.
- Keep it small enough that a person can read the whole diff.

Worse cases to refuse outright: code that hides its own behaviour (obfuscation, eval, remote fetch-and-run), code that writes outside \`.opencode\`, and anything the person has not seen.`,
  },
]

/** Writes the skill files so each skill's `path` is a real file the agent can open. */
export async function writeSkills(project: string, all: readonly SkillText[]): Promise<string> {
  const root = skillsRoot(project)
  for (const skill of all) {
    const file = path.join(root, skill.id, "SKILL.md")
    const previous = await readFile(file, "utf8").catch(() => undefined)
    if (previous === skill.content) continue
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, skill.content)
  }
  return root
}
