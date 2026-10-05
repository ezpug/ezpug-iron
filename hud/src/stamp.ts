/**
 * **The build stamp** (PRD-09 T8). Nothing on a client's screen said which revision of
 * the addon it had mounted, and Steam serves a republish late and a client caches what
 * it mounted (docs/hud.md, "Changing it"), so a look at a reel that does not move could
 * not tell a wrong stylesheet from a stale one. Now every layout with a stamp label
 * carries seven hex characters of a hash over the whole of `hud/`'s sources, written in
 * by `pnpm hud:build` before the compile, drawn small on the welcome card and in the
 * reel's window, and named by the manifest, the publish and the plugin's `ezpug_status`.
 * A look reads it off the card; the server says which one it was built beside.
 *
 * The stamp cannot be the pack's hash: the pack contains the layouts, and the layouts
 * contain the stamp. So it is the hash of the sources with the stamp's own characters
 * held at a placeholder, which makes it a fixed point: stamping twice writes the same
 * seven characters, and any other byte of any source changes them.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256, sources } from './addon.ts'

/** What a layout says in the label before the build writes the stamp, and what the hash sees in its place. */
export const STAMP_PLACEHOLDER = '0000000'

/** The stamp label: a `Label` whose class ends in `-stamp`, with the stamp as its text. */
const STAMP_LABEL = /(<Label class="ezpug-[a-z-]*-stamp"[^>]*\btext=")([^"]*)(")/g
/** The same, for one look (a `g` regex's `test` remembers where it stopped). */
const HAS_STAMP_LABEL = new RegExp(STAMP_LABEL.source)

/** Where a stamp is written: every layout that carries a stamp label, by its path in `hud/`. */
export function stampedLayouts(hudDir: string): string[] {
  return sources(hudDir)
    .map(s => s.source)
    .filter(source => source.endsWith('.xml'))
    .filter(source => HAS_STAMP_LABEL.test(readFileSync(join(hudDir, source), 'utf8')))
}

/** The stamp of what is in `hud/` now: seven hex characters, the same whatever the label says. */
export function stampOf(hudDir: string): string {
  const hash = sources(hudDir)
    .map(s => {
      const bytes = readFileSync(join(hudDir, s.source))
      const text = s.source.endsWith('.xml')
        ? bytes.toString('utf8').replace(STAMP_LABEL, `$1${STAMP_PLACEHOLDER}$3`)
        : bytes
      return `${s.source} ${sha256(text)}`
    })
    .join('\n')
  return sha256(hash).slice(0, 7)
}

/** What the layouts say now, by layout; a layout is in the list once per stamp label it carries. */
export function stampsWritten(hudDir: string): { layout: string; stamp: string }[] {
  const written: { layout: string; stamp: string }[] = []
  for (const layout of stampedLayouts(hudDir))
    for (const match of readFileSync(join(hudDir, layout), 'utf8').matchAll(STAMP_LABEL))
      written.push({ layout, stamp: match[2]! })
  return written
}

/** Write the stamp into every stamp label; the stamp it wrote. */
export function stampLayouts(hudDir: string): string {
  const stamp = stampOf(hudDir)
  for (const layout of stampedLayouts(hudDir)) {
    const path = join(hudDir, layout)
    const before = readFileSync(path, 'utf8')
    const after = before.replace(STAMP_LABEL, `$1${stamp}$3`)
    if (after !== before) writeFileSync(path, after)
  }
  return stamp
}

/** Every way the layouts' stamps disagree with the sources; empty means every label says what `stampOf` says. */
export function stampProblems(hudDir: string): string[] {
  const stamp = stampOf(hudDir)
  const problems: string[] = []
  const written = stampsWritten(hudDir)
  if (written.length === 0)
    problems.push('no layout carries a stamp label (a `Label` whose class ends in `-stamp`)')
  for (const { layout, stamp: says } of written)
    if (says !== stamp)
      problems.push(
        `hud/${layout} is stamped ${says}, the sources stamp ${stamp}: run \`pnpm hud:build\``,
      )
  return problems
}
