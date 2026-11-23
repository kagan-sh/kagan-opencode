# kagan

Makes opencode self-extensible. The agent writes an extension, checks it, and asks you to approve it before it runs. Extensions wait in `.opencode/staging`; opencode only loads `.opencode/plugins`.

Needs opencode v2 (`@opencode/plugin` 2.x).

## The loop

1. **Learn.** Four short skills teach the API: `ext-overview`, `ext-server`, `ext-tui`, `ext-safety`. They point at the real `.d.ts` files and docs instead of copying them.
2. **Stage.** `ext_new { id, kind }` scaffolds `.opencode/staging/<id>`. Nothing there runs: discovery only reads `.opencode/plugins`.
3. **Check.** `ext_check { id }` checks the folder shape, the id, the imports, and typechecks against the host's own `@opencode/plugin` types. It never runs the extension.
4. **Promote.** `ext_promote { id }` shows the files, the contributions it could find (tools, hooks, files, network) and a diff, then asks you. Only then is it copied into `.opencode/plugins/<id>` and loaded.
5. **See the result.** `ext_status` lists staged and installed extensions, and every plugin that failed with its error.
6. **Undo.** `ext_remove` deletes an installed extension, `ext_revert` swaps it back to the version the last promote replaced. Both ask.

## What it adds

| | |
| --- | --- |
| Tools | `ext_new`, `ext_check`, `ext_status`, `ext_promote`, `ext_remove`, `ext_revert` |
| Skills | `ext-overview`, `ext-server`, `ext-tui`, `ext-safety` |
| Rule | a short system rule: stage, check, promote, never write into `plugins/` yourself |
| TUI | `/extensions` page (staged, installed, failed; diff; approve, reject, remove, revert), a failure badge in `sidebar.footer`, `ctrl+shift+e` |
| Guards | a permission hook turns writes into `.opencode/plugins` into a question, including obvious shell commands |
| Trail | every promote, reject, remove and revert is recorded in opencode's storage, with who did it and the content hash |

## Safety, honestly

An opencode extension runs with your full rights: it can read files, read credentials, start processes and reach the network. opencode has no sandbox for plugins, and this kit cannot add one.

So the approval step is **a convention plus guards, not a lock**:

- staged code really cannot run, because opencode does not read `.opencode/staging`;
- promote really does ask you, and shows you the diff and what the extension touches;
- an agent with shell access can still write into `.opencode/plugins` itself. The permission guard catches the common paths, not every one;
- `ext_check` proves shape and types, not behaviour.

Read the diff. Approve small things. Revert what you do not trust.

## Install

```bash
opencode plugin add @kagan-sh/kagan
```

For local development, add the folder to `plugins` in `opencode.jsonc` instead.

## Development

```bash
bun install
bun test              # tools, guards, staging, promote/revert, typecheck
bunx tsc --noEmit
bun run e2e           # real opencode in a throwaway project with its own config dir
```

## License

[MIT](LICENSE)
