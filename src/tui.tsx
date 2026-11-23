import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { can, items, label, type Verb } from "./page.ts"
import { Kit as Contract, type WireDiff, type WireReply, type WireSnapshot } from "./rpc.ts"

const page = "kagan.ext.page"

/** What the page is showing instead of the list: the whole diff to read, and optionally to approve. */
interface Review {
  readonly title: string
  readonly text: string
  readonly install?: () => Promise<WireReply>
}

function Extensions() {
  const ctx = usePlugin()
  const location = () => ctx.location ?? ctx.data.location.default()
  const server = () => ctx.client.rpc(Contract)
  const [snapshot, setSnapshot] = createSignal<WireSnapshot | undefined>()
  const [cursor, setCursor] = createSignal(0)
  const [review, setReview] = createSignal<Review | undefined>()

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
   * A staged copy is read in full, in a view that scrolls, before anyone can
   * approve it. The install carries the hash of exactly the text on screen.
   * Every other action only needs a yes: rejecting reads nothing.
   */
  const act = async (verb: string, perform: (id: string, hash: string) => Promise<WireReply>) => {
    const item = selected()
    if (!item) return
    try {
      if (item.kind === "staged" && verb === "Install") {
        const diff = (await server().diff({ id: item.id }, { location: location() })) as WireDiff
        setReview({
          title: `${verb} ${item.id}?  hash ${diff.hash}`,
          text: diff.text,
          install: () => perform(item.id, diff.hash),
        })
        return
      }
      const detail =
        item.kind === "staged"
          ? `${item.id} is staged and has not run. Rejecting deletes the staged copy; an installed version, if any, stays.`
          : item.kind === "installed"
            ? `${item.id} is installed and ${item.status}.${item.error ? `\n\n${item.error}` : ""}`
            : `${item.id} failed to load.\n\n${item.error}`
      if (!(await confirm(`${verb} ${item.id}?`, detail, verb))) return
      show(await perform(item.id, ""))
    } catch (error) {
      fail(error)
    }
    await refresh()
  }

  const commit = async () => {
    const pending = review()
    if (!pending?.install) return
    setReview(undefined)
    try {
      show(await pending.install())
    } catch (error) {
      fail(error)
    }
    await refresh()
  }

  const read = async (id: string) => {
    try {
      const diff = (await server().diff({ id }, { location: location() })) as WireDiff
      setReview({ title: `Extension ${id}  hash ${diff.hash}`, text: diff.text })
    } catch (error) {
      fail(error)
    }
  }

  void refresh()
  const stop = ctx.data.on("plugin.updated", () => void refresh())
  onCleanup(stop)

  const listing = () => review() === undefined
  const acts = (verb: Verb) => listing() && can(verb, selected())

  ctx.keymap.layer(() => ({
    mode: "global",
    // Only while this page is on screen: `a`, `x`, `q` and the arrows belong to the prompt otherwise.
    enabled: () => ctx.ui.router.current().type === "plugin",
    commands: [
      { id: `${page}.up`, bind: "up", enabled: listing, run: () => move(-1) },
      { id: `${page}.down`, bind: "down", enabled: listing, run: () => move(1) },
      { id: `${page}.up.k`, bind: "k", enabled: listing, run: () => move(-1) },
      { id: `${page}.down.j`, bind: "j", enabled: listing, run: () => move(1) },
      { id: `${page}.diff`, bind: "o", title: "Show the diff", enabled: () => acts("diff"), run: () => void read(selected()!.id) },
      {
        id: `${page}.approve`,
        bind: "a",
        title: "Approve and install",
        enabled: () => acts("approve"),
        run: () => void act("Install", (id, hash) => server().approve({ id, hash }, { location: location() }) as Promise<WireReply>),
      },
      {
        id: `${page}.reject`,
        bind: "x",
        title: "Reject and delete the staged copy",
        enabled: () => acts("reject"),
        run: () => void act("Reject", (id) => server().reject({ id }, { location: location() }) as Promise<WireReply>),
      },
      {
        id: `${page}.remove`,
        bind: "d",
        title: "Remove the installed extension",
        enabled: () => acts("remove"),
        run: () => void act("Remove", (id) => server().remove({ id }, { location: location() }) as Promise<WireReply>),
      },
      {
        id: `${page}.revert`,
        bind: "v",
        title: "Go back to the saved version",
        enabled: () => acts("revert"),
        run: () => void act("Revert", (id) => server().revert({ id }, { location: location() }) as Promise<WireReply>),
      },
      { id: `${page}.close`, bind: "q", title: "Close extensions", enabled: listing, run: () => ctx.ui.router.navigate({ type: "home" }) },
      {
        id: `${page}.install`,
        bind: "return",
        title: "Install the reviewed change",
        enabled: () => !!review()?.install,
        run: () => void commit(),
      },
      { id: `${page}.back`, bind: "escape", enabled: () => !listing(), run: () => setReview(undefined) },
    ],
  }))

  return (
    <Show
      when={review()}
      fallback={
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
      }
    >
      {(view: () => Review) => (
        <box flexDirection="column">
          <text fg="yellow">{view().title}</text>
          <scrollbox flexGrow={1} focused>
            <text>{view().text}</text>
          </scrollbox>
          <text>{view().install ? "up/down scroll  enter install  esc back" : "up/down scroll  esc back"}</text>
        </box>
      )}
    </Show>
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
