import { Plugin, Skill } from "@opencode/plugin"
import path from "node:path"
import { guard } from "./guard.ts"
import { createKit } from "./kit.ts"
import { assertId } from "./paths.ts"
import { Kit as Contract, type WireReply } from "./rpc.ts"
import { skills, writeSkills } from "./skills.ts"
import { extensionTools } from "./tools.ts"

const rule = `# Extending opencode

You can add tools, commands, hooks and terminal UI parts to this opencode by writing an extension.

- Load the \`ext-overview\` skill before writing one; \`ext-server\` and \`ext-tui\` have the API, \`ext-safety\` the risks.
- Write into \`.opencode/staging/<id>\` with \`ext_new\`. Nothing there runs. \`ext_check\` must pass.
- \`ext_promote\` asks the person to approve, then installs it. \`ext_remove\` and \`ext_revert\` ask too.
- Never write into \`.opencode/plugins\` yourself: code there runs at once with the person's full rights.
- Approval is a convention plus guards, not a sandbox. Say so when you propose an extension.`

const idOf = (input: unknown) => assertId((input as { id?: unknown } | undefined)?.id)

export default Plugin.define({
  id: "kagan.ext",
  async setup(ctx) {
    const project = ctx.location.directory
    const kit = createKit({
      project,
      plugins: async () => (await ctx.plugin.list()).data,
      storage: ctx.storage,
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

    await ctx.permission.hook("evaluate", (event) => guard(project, event))

    const reply = async (act: () => Promise<string>): Promise<WireReply> => {
      try {
        return { ok: true, message: await act() }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }

    await ctx.rpc.register(Contract, {
      snapshot: () => kit.snapshot(),
      diff: async (input) => ({ text: await kit.describe(idOf(input)) }),
      approve: async (input) => {
        const id = idOf(input)
        return reply(async () => {
          const promoted = await kit.approve(id, "tui")
          return `promoted ${id} (${promoted.files.join(", ")})`
        })
      },
      reject: async (input) => {
        const id = idOf(input)
        return reply(async () => {
          await kit.reject(id, "tui")
          return `rejected ${id}; the staged copy is gone`
        })
      },
      remove: async (input) => {
        const id = idOf(input)
        return reply(async () => `removed ${id}, ${(await kit.remove(id, "tui")).length} files`)
      },
      revert: async (input) => {
        const id = idOf(input)
        return reply(async () => `reverted ${id} to ${(await kit.revert(id, "tui")).stamp}`)
      },
    })
  },
})
