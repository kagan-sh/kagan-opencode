// Loaded only by ext_check, so a staged extension typechecks without the
// host's optional peers installed. Everything below is `any` by design: the
// check proves how the extension uses the opencode API, not Solid or OpenTUI.
declare module "solid-js"
declare module "@opentui/solid"
declare module "@opentui/core"
declare module "@opencode/theme/tui"

declare namespace JSX {
  interface IntrinsicElements {
    [element: string]: any
  }
}
