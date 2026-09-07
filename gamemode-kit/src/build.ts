import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'vite'
import {
  WIDGET_BUNDLE,
  type WidgetLibraryOptions,
  type WidgetPaths,
  widgetLibraryConfig,
  widgetPaths,
} from './vite'

/**
 * **`buildWidget`** — the preset, run, and the bundle checked: exactly one
 * file, and nothing in it that would reach the network but the socket. A
 * widget lives in a sandboxed frame with a CSP of `default-src 'none'` and
 * a `connect-src` of the orchestrator alone; a `fetch()` in it would be a
 * broken widget on the match page, so the build refuses to produce one.
 */

export interface BuiltWidget extends WidgetPaths {
  /** The bundle, absolute. */
  file: string
  bytes: number
  /** SHA-256 of the bundle, hex — the orchestrator's content hash. */
  sha256: string
}

/** What a widget bundle must not contain: every way out of the frame but a WebSocket. */
const FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  { name: 'fetch()', pattern: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { name: 'EventSource', pattern: /\bEventSource\b/ },
  { name: 'navigator.sendBeacon', pattern: /\bsendBeacon\b/ },
  { name: 'a dynamic import()', pattern: /\bimport\s*\(/ },
  { name: 'importScripts', pattern: /\bimportScripts\b/ },
]

export function checkWidgetBundle(source: string): string[] {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name)
}

export async function buildWidget(
  paths: WidgetPaths,
  options: WidgetLibraryOptions = {},
): Promise<BuiltWidget> {
  await build(widgetLibraryConfig(paths, options))
  const produced = readdirSync(paths.outDir).filter(name => !name.endsWith('.map'))
  const expected = WIDGET_BUNDLE.split('/').at(-1) as string
  if (produced.length !== 1 || produced[0] !== expected)
    throw new Error(
      `ezpug-widget: ${paths.id} built ${produced.join(', ') || 'nothing'}; a widget is exactly one ${expected}`,
    )
  const file = join(paths.outDir, expected)
  const source = readFileSync(file, 'utf8')
  const found = checkWidgetBundle(source)
  if (found.length > 0)
    throw new Error(
      `ezpug-widget: ${paths.id}'s bundle reaches for ${found.join(', ')} — a widget talks to nothing but its socket (docs/gamemodes.md "Building a widget")`,
    )
  return {
    ...paths,
    file,
    bytes: statSync(file).size,
    sha256: createHash('sha256').update(source).digest('hex'),
  }
}

/** Every mode under `gamemodesDir` with a `widget/index.ts`, in name order. */
export function findWidgets(gamemodesDir: string, only?: readonly string[]): WidgetPaths[] {
  const ids = readdirSync(gamemodesDir, { withFileTypes: true })
    .filter(
      entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules',
    )
    .map(entry => entry.name)
    .sort()
  const wanted = only && only.length > 0 ? ids.filter(id => only.includes(id)) : ids
  for (const id of only ?? [])
    if (!ids.includes(id)) throw new Error(`ezpug-widget: no gamemode ${id} under ${gamemodesDir}`)
  return wanted
    .map(id => widgetPaths(join(gamemodesDir, id)))
    .filter((p): p is WidgetPaths => p !== null)
}
