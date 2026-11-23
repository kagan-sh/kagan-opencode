const maxLines = 400
const context = 3

/**
 * Line diff for the approval text. Not a patch file: no hunk headers, and long
 * unchanged runs collapse to `...`.
 *
 * shortcut: over 400 lines a side it prints both files whole instead of a
 * diff; swap in a real algorithm if extensions ever get that big.
 */
export function diffLines(before: string, after: string): string[] {
  const a = before === "" ? [] : before.split("\n")
  const b = after === "" ? [] : after.split("\n")
  if (a.length > maxLines || b.length > maxLines) return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)]

  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!)

  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`)
      i++
      j++
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!) {
      lines.push(`-${a[i++]}`)
    } else {
      lines.push(`+${b[j++]}`)
    }
  }
  while (i < a.length) lines.push(`-${a[i++]}`)
  while (j < b.length) lines.push(`+${b[j++]}`)
  return collapse(lines)
}

/** Keeps `context` lines around each change and replaces the rest with a marker. */
function collapse(lines: string[]): string[] {
  const keep = new Set<number>()
  lines.forEach((line, index) => {
    if (line.startsWith(" ")) return
    for (let at = Math.max(0, index - context); at <= Math.min(lines.length - 1, index + context); at++) keep.add(at)
  })
  const out: string[] = []
  let skipping = false
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      skipping = false
      out.push(line)
    } else if (!skipping) {
      skipping = true
      out.push(" ...")
    }
  })
  return out
}
