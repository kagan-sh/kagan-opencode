# AGENTS.md

opencode v2 plugin that lets an agent write, check and propose plugins.

- Bun 1.3+. `bun install`, `bun test`, `bunx tsc --noEmit`.
- Import only from `@opencode/plugin` (v2). `@opencode-ai/plugin` is v1 and does not run on v2.
- Staged code never runs: staging lives in `.opencode/staging`, which opencode does not watch. Only `.opencode/plugins` loads.
- Plan and design: `kagan-sh/kagan` repo, `.plans/opencode-plugin/assessment.md`.
- No AI trailers in commits.
