import { Plugin, Skill } from "@opencode/plugin"
import { skills } from "./skills.ts"
import { extensionTools } from "./tools.ts"

export default Plugin.define({
  id: "kagan.extend",
  setup: async (ctx) => {
    const tools = extensionTools({
      project: ctx.location.directory,
      plugins: async () => (await ctx.plugin.list()).data,
    })
    await ctx.tool.transform((editor) => tools.forEach((tool) => editor.add(tool)))
    await ctx.skill.transform((editor) => {
      for (const s of skills) {
        editor.add({
          id: Skill.ID.make(s.id),
          name: Skill.Name.make(s.id),
          description: s.description,
          autoinvoke: false,
          path: Skill.Info.fields.path.make(`${ctx.location.directory}/.opencode/staging/.skills/${s.id}/SKILL.md`),
          content: s.content,
        })
      }
    })
  },
})
