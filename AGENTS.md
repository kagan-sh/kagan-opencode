# AGENTS.md

opencode v2 plugin that lets an agent write, check and propose plugins.

- Bun 1.3+. `bun install`, `bun test`, `bunx tsc --noEmit`, `bunx oxlint src test scripts`.
- Import only from `@opencode/plugin` (v2). `@opencode-ai/plugin` is v1 and does not run on v2.
- Staged code never runs: staging lives in `.opencode/staging`, which opencode does not watch. Only `.opencode/plugins` loads.
- Approval binds to content: `describe` returns a hash, `approve { id, hash }` re-hashes the copy and refuses a mismatch. The promote request carries `id@hash` and asks as an `edit` of the target, because opencode 2.3.2's dialog renders a diff only for that action.
- Never cut what a person approves. If the whole diff or the whole file cannot be shown, refuse the promote.
- Say plainly what is not protected: the approval RPC is reachable by any local process, and a shell can write anywhere. Do not claim more than the e2e shows.
- Plan and design: `kagan-sh/kagan` repo, `.plans/opencode-plugin/assessment.md`.
- The TUI part needs `@opentui/solid` + `solid-js` types locally; they are optional peers at runtime.
- No AI trailers in commits.
