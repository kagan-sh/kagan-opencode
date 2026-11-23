import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { inspect, walkFiles } from "./inspect.ts"

/** Ambient stubs for the peers an extension may import but a project may not have. */
const shim = fileURLToPath(new URL("../shims/extension.d.ts", import.meta.url))

/** The installed @opencode/plugin package, found from this module's own dependency. */
function pluginRoot(): string | undefined {
  let root = path.dirname(fileURLToPath(import.meta.resolve("@opencode/plugin")))
  while (!existsSync(path.join(root, "dist", "promise", "index.d.ts"))) {
    const parent = path.dirname(root)
    if (parent === root) return undefined
    root = parent
  }
  return root
}

const limits = { lines: 30 }

/**
 * Typechecks the extension against the host's `@opencode/plugin` types. Runs no
 * extension code. Returns readable problems, or an empty list when it is clean.
 */
export async function typecheck(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await walkFiles(dir)
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  const roots = names.filter((name) => /\.(ts|tsx)$/.test(name)).map((name) => path.join(dir, name))
  if (roots.length === 0) return []

  const packageRoot = pluginRoot()
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
    lib: ["lib.es2022.d.ts"],
    types: [],
    baseUrl: dir,
    ...(packageRoot
      ? {
          paths: {
            "@opencode/plugin": [path.join(packageRoot, "dist", "promise", "index.d.ts")],
            "@opencode/plugin/tui": [path.join(packageRoot, "dist", "tui", "index.d.ts")],
            "@opencode/plugin/rpc": [path.join(packageRoot, "dist", "rpc.d.ts")],
            "@opencode/plugin/*": [path.join(packageRoot, "dist", "*.d.ts")],
          },
        }
      : {}),
  }

  const program = ts.createProgram({ rootNames: [...roots, shim], options })
  const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => dir,
    getNewLine: () => "\n",
  }
  const text = ts.formatDiagnostics(
    ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName !== shim),
    host,
  )
  return text
    .replaceAll(`${dir}${path.sep}`, "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, limits.lines)
}

/** Structural checks plus a typecheck. */
export async function check(dir: string, id: string): Promise<string[]> {
  const inspection = await inspect(dir, id)
  return [...inspection.problems, ...(await typecheck(dir))]
}
