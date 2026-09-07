import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GamemodeManifest } from '@ezpug/match-api'
import type { Log } from '../log'

/**
 * **The widget bundles** (decision 17, PRD-02 T25): what `gamemode-kit`
 * built for every `sdk` mode with a widget — `gamemodes/<id>/dist/widget.js`,
 * the manifest's `widget.entry` — read once at boot, hashed, and served by
 * `app.ts` at three paths:
 *
 *   GET /gamemodes/:id/widget/:hash/index.html   the document the platform mounts
 *   GET /gamemodes/:id/widget/:hash/widget.js    the bundle, beside it
 *   GET /gamemodes/:id/widget.js                 the current bundle by its stable name
 *
 * The hashed paths are **immutable** (a year of `Cache-Control`, and a hash
 * that is not this boot's is `404` rather than a stale answer); the stable
 * one revalidates on every request with the hash as its `ETag`. The
 * document's URL is what `GET /v1/gamemodes` advertises as `widget.url`
 * (`decorate`), so the platform mounts by address and never needs to know
 * how the address is built.
 *
 * A mode whose bundle is missing is a warning at boot and a manifest with
 * no `url`: the platform then mounts nothing for it, which is honest, and
 * `pnpm build` (or the image) is what makes the bundle. No secret is in a
 * bundle by construction — the build is a kit over source in this repo.
 */

/** The hash prefix in the URL: sixteen hex characters of the bundle's SHA-256. */
export const WIDGET_HASH_LENGTH = 16

export interface WidgetBundle {
  id: string
  /** The URL's hash — `sha256.slice(0, 16)`. */
  hash: string
  sha256: string
  source: string
  bytes: number
  /** Where it was read from. */
  file: string
}

export interface WidgetBundles {
  /** The directory the bundles were read from, or `null` when none was known. */
  readonly dir: string | null
  get: (id: string) => WidgetBundle | null
  ids: () => string[]
  /** The absolute URL of the document for one mode, or `null` without a bundle. */
  documentUrl: (id: string) => string | null
  /** The manifests as the catalog serves them: `widget.url` filled in where a bundle exists. */
  decorate: (manifests: readonly GamemodeManifest[]) => GamemodeManifest[]
}

export interface LoadWidgetBundlesOptions {
  gamemodes: readonly GamemodeManifest[]
  /** `gamemodes/`, holding `<id>/<entry>`; `null` reads nothing and warns once. */
  dir: string | null
  /** The orchestrator's own public origin — the URLs are absolute. */
  baseUrl: string
  log: Log
}

/** `/gamemodes/<id>/widget/<hash>/index.html`. */
export function widgetDocumentPath(id: string, hash: string): string {
  return `/gamemodes/${id}/widget/${hash}/index.html`
}

/** `/gamemodes/<id>/widget/<hash>/widget.js`. */
export function widgetScriptPath(id: string, hash: string): string {
  return `/gamemodes/${id}/widget/${hash}/widget.js`
}

/** `/gamemodes/<id>/widget.js` — the stable name. */
export function widgetStablePath(id: string): string {
  return `/gamemodes/${id}/widget.js`
}

/**
 * Where the workspace's `gamemodes/` is, through `@ezpug/gamemodes` — the
 * dev box's answer. In the image the package is bundled and nothing resolves,
 * so `EZPUG_IRON_GAMEMODES_DIR` says where the bundles were copied.
 */
export function defaultGamemodesDir(): string | null {
  try {
    return dirname(fileURLToPath(import.meta.resolve('@ezpug/gamemodes/package.json')))
  } catch {
    return null
  }
}

export function loadWidgetBundles(options: LoadWidgetBundlesOptions): WidgetBundles {
  const { gamemodes, log } = options
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const dir = options.dir ? resolve(options.dir) : null
  const bundles = new Map<string, WidgetBundle>()
  const wanted = gamemodes.filter(manifest => manifest.widget !== undefined)

  if (dir === null) {
    if (wanted.length > 0)
      log.warn(
        `widgets: no gamemodes directory (set EZPUG_IRON_GAMEMODES_DIR); ${wanted
          .map(m => m.id)
          .join(', ')} will be served without a widget url`,
      )
  } else {
    for (const manifest of wanted) {
      const entry = manifest.widget as NonNullable<GamemodeManifest['widget']>
      const file = resolve(dir, manifest.id, entry.entry)
      // `entry` is schema-checked to be a plain relative `.js` path, but the
      // one place a manifest field becomes a filesystem path deserves a fence.
      if (!file.startsWith(`${resolve(dir, manifest.id)}${sep}`)) {
        log.warn(
          `widgets: ${manifest.id}'s widget.entry ${entry.entry} escapes its directory; skipped`,
        )
        continue
      }
      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        log.warn(
          `widgets: ${manifest.id} has no bundle at ${file} — run \`pnpm build\`; served without a widget url`,
        )
        continue
      }
      const sha256 = createHash('sha256').update(source).digest('hex')
      const bundle: WidgetBundle = {
        id: manifest.id,
        hash: sha256.slice(0, WIDGET_HASH_LENGTH),
        sha256,
        source,
        bytes: Buffer.byteLength(source, 'utf8'),
        file,
      }
      bundles.set(manifest.id, bundle)
      log.info(`widgets: ${manifest.id} ${bundle.hash} (${bundle.bytes} bytes) from ${file}`)
    }
  }

  const documentUrl = (id: string): string | null => {
    const bundle = bundles.get(id)
    return bundle ? `${baseUrl}${widgetDocumentPath(id, bundle.hash)}` : null
  }

  return {
    dir,
    get: id => bundles.get(id) ?? null,
    ids: () => [...bundles.keys()],
    documentUrl,
    decorate: manifests =>
      manifests.map(manifest => {
        if (!manifest.widget) return manifest
        const url = documentUrl(manifest.id)
        if (!url) return manifest
        return { ...manifest, widget: { ...manifest.widget, url } }
      }),
  }
}

/**
 * The document: a viewport, a dark colour scheme, a transparent body (the
 * frame is the platform's surface) and the one module script beside it —
 * no inline script, nothing fetched but the bundle. The kit's shell in the
 * bundle creates `<ezpug-widget>` and runs the host handshake.
 */
export function widgetDocument(id: string): string {
  return [
    '<!doctype html>',
    '<html lang="de">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="robots" content="noindex">',
    `<title>EZPug · ${id}</title>`,
    '<style>html,body{margin:0;background:transparent}</style>',
    '</head>',
    '<body>',
    '<script type="module" src="./widget.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/**
 * The document's Content-Security-Policy: nothing by default, scripts from
 * this orchestrator only, a socket to it only, inline styles (Vue puts an
 * SFC's styles into the shadow root as `<style>` elements), data URLs for
 * an inlined image or font. The sources are host-sources without a scheme
 * — the platform frames the document over `https://gs.ezpug.com`, a dev
 * world over `http://localhost:3430`, and a sandboxed frame's own origin is
 * opaque so `'self'` would match nothing — for the host the request came
 * to and the one `baseUrl` names, plus `ws://` and `wss://` of each for the
 * socket, because a scheme-less source does not match a WebSocket.
 */
export function widgetCsp(hosts: readonly string[]): string {
  const unique = [...new Set(hosts.filter(host => host.length > 0))]
  const http = unique.join(' ')
  const ws = unique.flatMap(host => [`ws://${host}`, `wss://${host}`]).join(' ')
  return [
    "default-src 'none'",
    `script-src ${http}`,
    `connect-src ${http} ${ws}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** The host a request came to, as the CSP names it: `x-forwarded-host` behind a proxy, else the URL's. */
export function requestHost(url: string, forwardedHost: string | undefined): string {
  const forwarded = forwardedHost?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function baseUrlHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}
