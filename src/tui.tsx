import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { Kit as Contract, type WireDiff, type WireReply, type WireSnapshot } from "./rpc.ts"

const page = "kagan.ext.page"

type Item =
  | { readonly kind: "staged"; readonly id: string; readonly installed: boolean }
  | {
      readonly kind: "installed"
      readonly id: string
      readonly status: string
      readonly error: string
      readonly revertable: boolean
    }

const items = (snapshot: WireSnapshot | undefined): Item[] =>
  snapshot
    ? [
        ...snapshot.staged.map((staged) => ({ kind: "staged" as const, ...staged })),
        ...snapshot.installed.map((installed) => ({ kind: "installed" as const, ...installed })),
      ]
    : []

const label = (item: Item) =>
  item.kind === "staged"
    ? `staged     ${item.id}${item.installed ? " (installed)" : ""}`
    : `installed  ${item.id} ${item.status}${item.error ? `: ${item.error}` : ""}`

function Extensions() {
  const ctx = usePlugin()
  const location = () => ctx.location ?? ctx.data.location.default()
  const server = () => ctx.client.rpc(Contract)
  const [snapshot, setSnapshot] = createSignal<WireSnapshot | undefined>()
  const [cursor, setCursor] = createSignal(0)

  const refresh = async () => {
    const next = (await server().snapshot({}, { location: location() })) as WireSnapshot
    setSnapshot(next)
    setCursor((current) => Math.min(current, Math.max(0, items(next).length - 1)))
  }

  const selected = () => items(snapshot())[cursor()]
  const move = (by: number) => {
    setCursor((current) => Math.min(Math.max(0, current + by), Math.max(0, items(snapshot()).length - 1)))
  }

  const confirm = (title: string, message: string, confirmLabel: string) =>
    ctx.ui.dialog.confirm({ title, message, label: { confirm: confirmLabel, cancel: "Cancel" } })

  const show = (result: WireReply) => ctx.ui.toast.show({ message: result.message, variant: result.ok ? "success" : "error" })

  /** A confirm is a window, not a viewer: cap the diff and point at `o` for the rest. */
  const cap = (text: string) => (text.length > 1500 ? `${text.slice(0, 1500)}\n... (o shows the whole diff)` : text)

  const act = async (run: (id: string) => Promise<WireReply>) => {
    const item = selected()
    if (!item) return
    const diff = (await server().diff({ id: item.id }, { location: location() })) as WireDiff
    const ok = await confirm(`${item.kind === "staged" ? "Promote" : "Change"} ${item.id}?`, cap(diff.text), "Do it")
    if (!ok) return
    show(await run(item.id))
    await refresh()
  }

  const loadDiff = async (id: string) => {
    const diff = (await server().diff({ id }, { location: location() })) as WireDiff
    await ctx.ui.dialog.alert({ title: `Extension ${id}`, message: diff.text })
  }

  void refresh()
  const stop = ctx.data.on("plugin.updated", () => void refresh())
  onCleanup(stop)

  const staged = () => selected()?.kind === "staged"
  const installed = (onlyRevertable = false) => {
    const item = selected()
    return item?.kind === "installed" && (!onlyRevertable || item.revertable)
  }

  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      { id: `${page}.up`, bind: "up", run: () => move(-1) },
      { id: `${page}.down`, bind: "down", run: () => move(1) },
      { id: `${page}.up.k`, bind: "k", run: () => move(-1) },
      { id: `${page}.down.j`, bind: "j", run: () => move(1) },
      { id: `${page}.diff`, bind: "o", title: "Show the diff", enabled: () => !!selected(), run: () => void loadDiff(selected()!.id) },
      {
        id: `${page}.approve`,
        bind: "a",
        title: "Approve and install",
        enabled: staged,
        run: () => void act((id) => server().approve({ id }, { location: location() }) as Promise<WireReply>),
      },
      {
        id: `${page}.reject`,
        bind: "x",
        title: "Reject and delete the staged copy",
        enabled: staged,
        run: () => void act((id) => server().reject({ id }, { location: location() }) as Promise<WireReply>),
      },
      {
        id: `${page}.remove`,
        bind: "d",
        title: "Remove the installed extension",
        enabled: () => installed(),
        run: () => void act((id) => server().remove({ id }, { location: location() }) as Promise<WireReply>),
      },
      {
        id: `${page}.revert`,
        bind: "v",
        title: "Go back to the saved version",
        enabled: () => installed(true),
        run: () => void act((id) => server().revert({ id }, { location: location() }) as Promise<WireReply>),
      },
      { id: `${page}.close`, bind: "q", title: "Close extensions", run: () => ctx.ui.router.navigate({ type: "home" }) },
    ],
  }))

  return (
    <box flexDirection="column">
      <text>Extensions</text>
      <Show when={snapshot()} fallback={<text>loading...</text>}>
        <For each={items(snapshot())}>{(item, index) => <text fg={index() === cursor() ? "yellow" : "gray"}>{label(item)}</text>}</For>
        <Show when={items(snapshot()).length === 0}>
          <text>nothing staged or installed; ask the agent to ext_new one</text>
        </Show>
        <text> </text>
        <text>a approve  x reject  d remove  v revert  o diff  q close</text>
        <text>staged code does not run. installed code runs with your full rights.</text>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "kagan.ext.tui",
  setup(ctx) {
    const location = () => ctx.location ?? ctx.data.location.default()
    const [failed, setFailed] = createSignal(0)

    const count = async () => {
      const rows = await ctx.client.plugin.list({ location: location() })
      setFailed(rows.data.filter((row) => row.state.status === "failed").length)
    }
    void count()
    const stop = ctx.data.on("plugin.updated", () => void count())

    const route = ctx.ui.router.register({ name: "extensions", render: () => <Extensions /> })
    const slot = ctx.ui.slot({
      append: "sidebar.footer",
      render: () => (
        <Show when={failed() > 0}>
          <text fg="red">{`${failed()} extension${failed() === 1 ? "" : "s"} failed - /extensions`}</text>
        </Show>
      ),
    })

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: `${page}.open`,
          title: "Extensions",
          group: "Kagan",
          bind: "ctrl+shift+e",
          palette: true,
          slash: { name: "extensions" },
          run: () => ctx.ui.router.navigate({ type: "plugin", name: "extensions" }),
        },
      ],
    }))

    return () => {
      stop()
      route()
      slot()
    }
  },
})
