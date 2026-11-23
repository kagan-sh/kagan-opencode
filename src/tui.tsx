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
  | { readonly kind: "failed"; readonly id: string; readonly error: string }

const items = (snapshot: WireSnapshot | undefined): Item[] => {
  if (!snapshot) return []
  const installed = snapshot.installed.map((item) => ({ kind: "installed" as const, ...item }))
  // A failed plugin need not be one the kit installed: list every failure the host reports.
  const failed = snapshot.failed
    .filter((item) => !snapshot.installed.some((row) => row.id === item.label))
    .map((item) => ({ kind: "failed" as const, id: item.label, error: item.error }))
  return [...snapshot.staged.map((item) => ({ kind: "staged" as const, ...item })), ...installed, ...failed]
}

const first = (text: string) => text.split("\n")[0] ?? ""

const label = (item: Item) => {
  if (item.kind === "staged") return `staged     ${item.id}${item.installed ? " (installed)" : ""}`
  if (item.kind === "failed") return `failed     ${item.id}: ${first(item.error)}`
  return `installed  ${item.id} ${item.status}${item.error ? `: ${first(item.error)}` : ""}`
}

function Extensions() {
  const ctx = usePlugin()
  const location = () => ctx.location ?? ctx.data.location.default()
  const server = () => ctx.client.rpc(Contract)
  const [snapshot, setSnapshot] = createSignal<WireSnapshot | undefined>()
  const [cursor, setCursor] = createSignal(0)

  const refresh = async () => {
    try {
      const next = (await server().snapshot({}, { location: location() })) as WireSnapshot
      setSnapshot(next)
      setCursor((current) => Math.min(current, Math.max(0, items(next).length - 1)))
    } catch {
      // A reload tears the RPC down for a moment; the next plugin.updated event retries.
    }
  }

  const selected = () => items(snapshot())[cursor()]
  const move = (by: number) => {
    setCursor((current) => Math.min(Math.max(0, current + by), Math.max(0, items(snapshot()).length - 1)))
  }

  const confirm = (title: string, message: string, confirmLabel: string) =>
    ctx.ui.dialog.confirm({ title, message, label: { confirm: confirmLabel, cancel: "Cancel" } })

  const show = (result: WireReply) => ctx.ui.toast.show({ message: result.message, variant: result.ok ? "success" : "error" })
  const fail = (error: unknown) =>
    ctx.ui.toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" })

  /**
   * What the person agrees to: the whole diff for a staged copy, whose hash is
   * carried into the approval; the state for an installed one.
   */
  const act = async (verb: string, run: (id: string, hash: string) => Promise<WireReply>) => {
    const item = selected()
    if (!item) return
    try {
      let hash = ""
      let detail = ""
      if (item.kind === "staged") {
        const diff = (await server().diff({ id: item.id }, { location: location() })) as WireDiff
        detail = diff.text
        hash = diff.hash
      } else if (item.kind === "installed") {
        detail = `${item.id} is installed and ${item.status}.${item.error ? `\n\n${item.error}` : ""}`
      } else {
        detail = `${item.id} failed to load.\n\n${item.error}`
      }
      const ok = await confirm(`${verb} ${item.id}?`, detail, verb)
      if (!ok) return
      show(await run(item.id, hash))
    } catch (error) {
      fail(error)
    }
    await refresh()
  }

  const loadDiff = async (id: string) => {
    try {
      const diff = (await server().diff({ id }, { location: location() })) as WireDiff
      await ctx.ui.dialog.alert({ title: `Extension ${id}`, message: diff.text })
    } catch (error) {
      fail(error)
    }
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
    // Only while this page is on screen: `a`, `x`, `q` and the arrow keys belong to the prompt otherwise.
    enabled: () => ctx.ui.router.current().type === "plugin",
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
        run: () => void act("Install", (id, hash) => server().approve({ id, hash }, { location: location() }) as Promise<WireReply>),
      },
      {
        id: `${page}.reject`,
        bind: "x",
        title: "Reject and delete the staged copy",
        enabled: staged,
        run: () => void act("Reject", (id) => server().reject({ id }, { location: location() }) as Promise<WireReply>),
      },
      {
        id: `${page}.remove`,
        bind: "d",
        title: "Remove the installed extension",
        enabled: () => installed(),
        run: () => void act("Remove", (id) => server().remove({ id }, { location: location() }) as Promise<WireReply>),
      },
      {
        id: `${page}.revert`,
        bind: "v",
        title: "Go back to the saved version",
        enabled: () => installed(true),
        run: () => void act("Revert", (id) => server().revert({ id }, { location: location() }) as Promise<WireReply>),
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
    void count().catch(() => undefined)
    const stop = ctx.data.on("plugin.updated", () => void count().catch(() => undefined))

    // The server part can change files but cannot reload a location; this part can.
    const stopChanges = ctx.client.rpc(Contract).events.on("changed", async (event) => {
      if (event.location && event.location.directory !== location().directory) return
      await ctx.client.location.reload().catch(() => undefined)
      await count().catch(() => undefined)
    })

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
      stopChanges()
      route()
      slot()
    }
  },
})
