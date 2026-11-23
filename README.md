# kagan

Makes opencode self-extensible. The agent writes an extension, checks it, and asks you to approve it before it runs. Extensions wait in `.opencode/staging`; opencode only loads `.opencode/plugins`.

Needs opencode v2 (`@opencode/plugin` 2.x). The kit pins 2.3.2 for its typecheck.

## The loop

1. **Learn.** Four short skills teach the API: `ext-overview`, `ext-server`, `ext-tui`, `ext-safety`. They point at the real `.d.ts` files each tool prints and at the docs, instead of copying them.
2. **Stage.** `ext_new { id, kind }` scaffolds `.opencode/staging/<id>`. Nothing there runs: discovery only reads `.opencode/plugins`.
3. **Check.** `ext_check { id }` checks the folder shape, the ids, the imports, and typechecks against the kit's pinned `@opencode/plugin` 2.3.2 types — its own copy, not the host's install, so a host on 2.4 may differ. It never runs the extension.
4. **Promote.** `ext_promote { id }` shows every file with its size and hash, the contributions it could find by regex (hints, not a proof), and the **whole** diff, then asks you. Approval is bound to the hash of exactly those bytes; only then is the copy installed into `.opencode/plugins/<id>`. A change too large to show in full, or a file that is not UTF-8 text, is refused — split or simplify the extension. opencode does not always notice a new folder there by itself: with `/extensions` open it reloads the location, otherwise restart opencode.
5. **See the result.** `ext_status` lists staged and installed extensions, and every plugin that failed with its error.
6. **Undo.** `ext_remove` deletes an installed extension, `ext_revert` swaps it back to the version the last promote replaced. Both ask.

If it failed to load: edit staging, `ext_check`, `ext_promote` again. A promote replaces the installed copy and keeps the old one for `ext_revert`.

## What it adds

| | |
| --- | --- |
| Tools | `ext_new`, `ext_check`, `ext_status`, `ext_promote`, `ext_remove`, `ext_revert` |
| Skills | `ext-overview`, `ext-server`, `ext-tui`, `ext-safety` |
| Rule | a short system rule: stage, check, promote, never write into `plugins/` yourself |
| TUI | `/extensions` page (staged, installed, failed; diff; approve, reject, remove, revert), a failure badge in `sidebar.footer`, `ctrl+shift+e` |
| Guards | a permission hook turns every `ext.*` action, writes into `.opencode/plugins`, edits to the plugin config and calls to the approval RPC into a question |
| Trail | every promote, reject, remove and revert is recorded in opencode's storage, with who did it (`tool` or `rpc`), the content hash, and the files |

## Safety, honestly

An opencode extension runs with your full rights: it can read files, read credentials, start processes and reach the network. opencode has no sandbox for plugins, and this kit cannot add one.

So the approval step is **a convention plus guards, not a lock**:

- staged code really cannot run, because opencode does not read `.opencode/staging`;
- promote really does ask you, and shows every file's size and hash plus the whole diff; a change that cannot be shown in full is refused, not cut;
- the approval binds to content: `ext_promote` sends `id@hash` as its permission resource and passes `save: []`, so an "always" reply cannot cover a later version, and the copy is hashed again before it is renamed into place;
- **the approval RPC is reachable by any local process.** `approve`, `reject`, `remove` and `revert` are plain HTTP calls on opencode's API; an agent with a shell, or anything else that can reach the server, can `curl` them. The audit then says `via: rpc`, and the kit cannot tell a person from a program there;
- an agent with shell access can still write into `.opencode/plugins` itself, or anywhere else. The permission guard catches the common paths, not every one;
- `ext_check` proves shape and types, not behaviour.

Read the diff. Approve small things. Revert what you do not trust.

## Install

```bash
opencode plugin add @kagan-sh/kagan
```

`typescript` is a runtime dependency (about 20 MB): `ext_check` runs the compiler. For local development, add the folder to `plugins` in `opencode.jsonc` instead.

## Development

```bash
bun install
bun test              # tools, guards, staging, promote/revert, audit, RPC handlers, typecheck
bunx tsc --noEmit
bunx oxlint src test scripts
bun run e2e           # real opencode in a throwaway project with its own config dir
```

The kit creates `.opencode/staging/` and `.opencode/ext-kit/` on first use. If you keep `.opencode` in git, ignore the scratch folders: `.opencode/staging/.tmp/` and `.opencode/staging/.history/`.

## License

[MIT](LICENSE)
