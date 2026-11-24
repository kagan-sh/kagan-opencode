import { Plugin, Skill } from "@opencode/plugin"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { guard } from "./guard.ts"
import { handlers } from "./handlers.ts"
import { createKit } from "./kit.ts"
import { ensurePluginsRoot } from "./paths.ts"
import { Kit as Contract } from "./rpc.ts"
import { skills, writeSkills } from "./skills.ts"
import { extensionTools } from "./tools.ts"

const rule = `# Extending opencode

You can add tools, commands, hooks and terminal UI parts to this opencode by writing an extension.

- Load the \`ext-overview\` skill before writing one; \`ext-server\` and \`ext-tui\` have the API, \`ext-safety\` the risks.
- Write into \`.opencode/staging/<id>\` with \`ext_new\`. Nothing there runs. \`ext_check\` must pass.
- \`ext_promote\` asks the person through opencode's permission dialog as an edit of \`.opencode/plugins/<id>\`; the dialog shows every file with its size and hash and the whole change, and approval installs exactly that content. A decline installs nothing: do not retry. The same is true of \`ext_remove\` and \`ext_revert\`.
- The person can also use \`/extensions\` to read, approve, reject, remove or revert without the agent.
- Never write into \`.opencode/plugins\` yourself: code there runs at once with the person's full rights.
- Approval is a convention plus guards, not a sandbox: any local process that can reach opencode's API can approve, and a shell can write anywhere. Say so when you propose an extension.`

export default Plugin.define({
  id: "kagan.ext",
  async setup(ctx) {
    // Canonical, so the guard compares one path with the paths the edit tool reports.
    const project = await realpath(ctx.location.directory).catch(() => ctx.location.directory)
    await ensurePluginsRoot(project)

    let notify: ((change: { id: string; action: "promote" | "reject" | "remove" | "revert" }) => Promise<void>) | undefined
    let warn: ((message: string) => Promise<void>) | undefined
    const kit = createKit({
      project,
      plugins: async () => (await ctx.plugin.list()).data,
      storage: ctx.storage,
      onChange: async (change) => notify?.(change),
    })

    await ctx.tool.transform((editor) => {
      for (const tool of extensionTools({ kit, project, permission: ctx.permission })) editor.add(tool)
    })

    const written = await writeSkills(project, skills)
    await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        editor.add({
          id: Skill.ID.make(skill.id),
          name: Skill.Name.make(skill.id),
          description: skill.description,
          autoinvoke: false,
          path: Skill.Info.fields.path.make(path.join(written, skill.id, "SKILL.md")),
          content: skill.content,
        })
      }
    })

    await ctx.session.hook("context", (event) => {
      event.system.push({ type: "text", text: rule })
    })

    await ctx.permission.hook("evaluate", (event) => guard(project, event, (message) => void warn?.(message)))

    const registration = await ctx.rpc.register(Contract, handlers(kit))

    notify = async (change) => {
      await registration.events.emit("changed", change)
    }
    warn = async (message) => {
      await registration.events.emit("warned", { message })
    }
  },
})
