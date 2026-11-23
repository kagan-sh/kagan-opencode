# kagan

Makes opencode self-extensible. An agent scaffolds, checks and proposes plugins; a person approves them before they run.

Needs opencode v2 (`@opencode/plugin` 2.x).

## Tools and skills it adds

- `ext_new { id, kind }`: scaffold a plugin into `.opencode/staging/<id>`. Nothing there runs.
- `ext_check { id }`: check a staged plugin's shape. Runs no plugin code.
- `ext_status`: staged plugins, and which loaded plugins failed and why.
- Skills `ext-overview`, `ext-server`, `ext-tui`.

Promote (with approval) and the TUI `/extensions` page come in later slices.

## Install

```bash
opencode plugin -g @kagan-sh/kagan
```

## License

[MIT](LICENSE)
