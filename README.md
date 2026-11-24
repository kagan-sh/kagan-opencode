# kagan

Makes opencode self-extensible. The agent writes an extension, checks it, and asks you to approve it before it runs. Extensions wait in `.opencode/staging`; opencode only loads `.opencode/plugins`.

Needs opencode v2 (`@opencode/plugin` 2.x). The kit pins 2.3.2 for its typecheck.

## The loop

1. **Learn.** Four short skills teach the API: `ext-overview`, `ext-server`, `ext-tui`, `ext-safety`. They point at the real `.d.ts` files each tool prints and at the docs, instead of copying them.
2. **Stage.** `ext_new { id, kind }` scaffolds `.opencode/staging/<id>`. Nothing there runs: discovery only reads `.opencode/plugins`.
3. **Check.** `ext_check { id }` checks the folder shape, the ids, the imports, and typechecks against the kit's pinned `@opencode/plugin` 2.3.2 types — its own copy, not the host's install, so a host on 2.4 may differ. It never runs the extension.
4. **Promote.** `ext_promote { id }` asks you in opencode's permission dialog, as an edit of `.opencode/plugins/<id>` — the form whose dialog renders a diff. That dialog shows every file with its size and hash, the contributions it could find by regex (hints, not a proof), and the **whole** staged change, then asks you. Approval is bound to the hash of exactly those bytes; only then is the copy installed into `.opencode/plugins/<id>`. A change too large to show in full (over 12,000 characters of staged text), or a file that is not UTF-8 text, is refused — split or simplify the extension. opencode does not always notice a new folder there: a running terminal UI reloads by itself; otherwise restart opencode.
5. **See the result.** `ext_status` lists staged and installed extensions, and every server plugin that failed with its error.
6. **Undo.** `ext_remove` deletes an installed extension, `ext_revert` swaps it back to the version the last promote replaced. Both ask. A rejected ask says so in the tool's error, so the agent stops instead of retrying.

Everything above is also on the `/extensions` page, without the agent: read, approve, reject, remove, revert.

If it failed to load: edit staging, `ext_check`, `ext_promote` again. A promote replaces the installed copy and keeps the old one for `ext_revert`.

## What it adds

| | |
| --- | --- |
| Tools | `ext_new`, `ext_check`, `ext_status`, `ext_promote`, `ext_remove`, `ext_revert` |
| Skills | `ext-overview`, `ext-server`, `ext-tui`, `ext-safety` |
| Rule | a short system rule: stage, check, promote, never write into `plugins/` yourself |
| TUI | `/extensions` page (staged, installed, failed; diff; approve, reject, remove, revert), a badge for failed server plugins in `sidebar.footer`, `ctrl+shift+e` |
| Guards | a permission hook turns every `ext.*` action, writes into `.opencode/plugins`, edits to the plugin config (`opencode.json(c)`, `tui.json`, the global configs, `.opencode/package.json`) and calls to the approval RPC into a question; the reason is also sent to the terminal UI part as a toast, because the dialog does not render the message |
| Trail | every promote, reject, remove and revert is recorded in opencode's storage, with who did it (`tool` or `rpc`), the content hash, and the files |

The page and the sidebar badge count the server plugins opencode reports. Plugins from `tui.json` load in the terminal UI; their failures are listed only on opencode's own `/plugins` page, so its count can be higher.

## Safety, honestly

An opencode extension runs with your full rights: it can read files, read credentials, start processes and reach the network. opencode has no sandbox for plugins, and this kit cannot add one.

So the approval step is **a convention plus guards, not a lock**:

- staged code really cannot run, because opencode does not read `.opencode/staging`;
- promote really does ask you, and the dialog shows every file's size and hash plus the whole change; a change that cannot be shown in full is refused, not cut. opencode 2.3.2 renders a diff only for an `edit` action, so `ext_promote` asks as an edit of the target folder; what it shows is the staged content, and it installs only after you approve;
- the approval binds to content: the request carries `id@hash` and passes `save: []`, so an "always" reply cannot cover a later version, and the copy is hashed again before it is renamed into place. A rejection installs nothing and says so to the agent;
- **the approval RPC is reachable by any local process.** `approve`, `reject`, `remove` and `revert` are plain HTTP calls on opencode's API; an agent with a shell, or anything else that can reach the server, can `curl` them. The audit then says `via: rpc`, and the kit cannot tell a person from a program there;
- an agent with shell access can still write into `.opencode/plugins` itself, or anywhere else. The permission guard catches the common paths, not every one. It watches `opencode.json(c)`, `tui.json` and `.opencode/package.json`, in the project and in your global config, but a shell can spell a path in ways it will miss;
- `ext_check` proves shape and types, not behaviour.

Read the diff. Approve small things. Revert what you do not trust.

## Install

```bash
opencode plugin add @kagan-sh/kagan
```

The npm name `@kagan-sh/kagan` is shared with an old v1 `0.4.1` package. If a global `tui.json` or `cli.json` already lists `@kagan-sh/kagan@0.4.1` and it fails to load, remove that entry: otherwise opencode sees two packages with the same name, and the v2 kit is the one that works.

`typescript` is a runtime dependency (about 20 MB): `ext_check` runs the compiler. For local development, add the folder to `plugins` in `opencode.jsonc` instead.

## Development

```bash
bun install
bun test              # tools, guards, staging, promote/revert, audit, RPC handlers, typecheck
bunx tsc --noEmit
bunx oxlint src test scripts
bun run e2e           # real opencode in a throwaway project with its own config dir
```

At setup the kit makes `.opencode/plugins/` (opencode only watches the plugin folders it saw at startup) and `.opencode/ext-kit/skills/` (each registered skill points at a real file). `.opencode/staging/` appears on first use. If you keep `.opencode` in git, ignore the scratch folders: `.opencode/staging/` (including `.tmp/` and `.history/`) and `.opencode/ext-kit/`.

## License

[MIT](LICENSE)
