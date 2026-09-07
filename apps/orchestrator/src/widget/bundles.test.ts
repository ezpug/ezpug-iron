import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHIPPED_GAMEMODES } from '@ezpug/match-api'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, keyRequest } from '../http/testing'
import { createMemoryLog } from '../log'
import { loadWidgetBundles, widgetCsp, widgetDocument } from './bundles'

/**
 * The bundles as the orchestrator serves them (T25), over a stand-in
 * `powerup-dm` bundle in a temporary `gamemodes/` — the real one is
 * `gamemode-kit`'s build product and a unit test does not depend on a build
 * having run. What is proven: the hash, the three routes and their headers,
 * the document's CSP, the catalog advertising `widget.url`, and the honest
 * answer when a bundle is missing.
 */

const SOURCE =
  '// a stand-in widget bundle\ncustomElements.define("ezpug-widget", class extends HTMLElement {});\n'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function gamemodesDir(withBundle = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'ezpug-gamemodes-'))
  dirs.push(dir)
  if (withBundle) {
    mkdirSync(join(dir, 'powerup-dm', 'dist'), { recursive: true })
    writeFileSync(join(dir, 'powerup-dm', 'dist', 'widget.js'), SOURCE)
  }
  return dir
}

const HASH = createHash('sha256').update(SOURCE).digest('hex').slice(0, 16)

describe('loadWidgetBundles', () => {
  it('reads every sdk mode’s bundle, hashes it and decorates the catalog with its document url', () => {
    const log = createMemoryLog()
    const bundles = loadWidgetBundles({
      gamemodes: SHIPPED_GAMEMODES,
      dir: gamemodesDir(),
      baseUrl: 'https://gs.ezpug.com/',
      log,
    })
    expect(bundles.ids()).toEqual(['powerup-dm'])
    expect(bundles.get('powerup-dm')).toMatchObject({ hash: HASH, bytes: SOURCE.length })
    expect(bundles.get('pug')).toBeNull()
    expect(bundles.documentUrl('powerup-dm')).toBe(
      `https://gs.ezpug.com/gamemodes/powerup-dm/widget/${HASH}/index.html`,
    )
    const catalog = bundles.decorate(SHIPPED_GAMEMODES)
    expect(catalog.find(m => m.id === 'powerup-dm')?.widget).toEqual({
      entry: 'dist/widget.js',
      needs: ['tokens', 'locale', 'playerToken'],
      url: `https://gs.ezpug.com/gamemodes/powerup-dm/widget/${HASH}/index.html`,
    })
    expect(catalog.find(m => m.id === 'pug')?.widget).toBeUndefined()
    expect(
      log.lines.some(line => line.includes('widgets: powerup-dm') && line.includes(HASH)),
    ).toBe(true)
  })

  it('warns and serves no url for a mode whose bundle is missing, and with no directory at all', () => {
    const log = createMemoryLog()
    const missing = loadWidgetBundles({
      gamemodes: SHIPPED_GAMEMODES,
      dir: gamemodesDir(false),
      baseUrl: 'https://gs.ezpug.com',
      log,
    })
    expect(missing.ids()).toEqual([])
    expect(
      missing.decorate(SHIPPED_GAMEMODES).find(m => m.id === 'powerup-dm')?.widget?.url,
    ).toBeUndefined()
    expect(log.lines.some(line => line.includes('warn') && line.includes('no bundle'))).toBe(true)

    const none = loadWidgetBundles({
      gamemodes: SHIPPED_GAMEMODES,
      dir: null,
      baseUrl: 'https://gs.ezpug.com',
      log,
    })
    expect(none.dir).toBeNull()
    expect(none.documentUrl('powerup-dm')).toBeNull()
    expect(log.lines.some(line => line.includes('EZPUG_IRON_GAMEMODES_DIR'))).toBe(true)
  })
})

describe('the widget routes', () => {
  function serve() {
    const log = createMemoryLog()
    const widgets = loadWidgetBundles({
      gamemodes: SHIPPED_GAMEMODES,
      dir: gamemodesDir(),
      baseUrl: 'http://localhost:3430',
      log,
    })
    return createTestApp({ widgets })
  }

  it('advertises the document url in the catalog', async () => {
    const t = serve()
    const { secret } = await t.keys.mint(keyRequest('platform'))
    const catalog = await t.request('/v1/gamemodes', { key: secret })
    expect(catalog.status).toBe(200)
    const mode = catalog.body.gamemodes.find((m: { id: string }) => m.id === 'powerup-dm')
    expect(mode.widget.url).toBe(
      `http://localhost:3430/gamemodes/powerup-dm/widget/${HASH}/index.html`,
    )
    const one = await t.request('/v1/gamemodes/powerup-dm', { key: secret })
    expect(one.body.widget.url).toBe(mode.widget.url)
    const pug = await t.request('/v1/gamemodes/pug', { key: secret })
    expect(pug.body.widget).toBeUndefined()
  })

  it('serves the document immutable with a CSP for this orchestrator alone, and the script beside it', async () => {
    const t = serve()
    const document = await t.app.request(
      `http://localhost:3430/gamemodes/powerup-dm/widget/${HASH}/index.html`,
    )
    expect(document.status).toBe(200)
    expect(document.headers.get('content-type')).toMatch(/^text\/html/)
    expect(document.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(document.headers.get('x-content-type-options')).toBe('nosniff')
    expect(document.headers.get('content-security-policy')).toBe(widgetCsp(['localhost:3430']))
    const html = await document.text()
    expect(html).toBe(widgetDocument('powerup-dm'))
    expect(html).toContain('<script type="module" src="./widget.js"></script>')
    expect(html).not.toMatch(/<script>[^<]/)

    const forwarded = await t.app.request(
      `http://localhost:3430/gamemodes/powerup-dm/widget/${HASH}/index.html`,
      { headers: { 'x-forwarded-host': 'gs.ezpug.com' } },
    )
    expect(forwarded.headers.get('content-security-policy')).toBe(
      widgetCsp(['gs.ezpug.com', 'localhost:3430']),
    )

    const script = await t.app.request(
      `http://localhost:3430/gamemodes/powerup-dm/widget/${HASH}/widget.js`,
    )
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    // The document's origin is opaque in the platform's sandboxed frame, so
    // its module script is a CORS request from `null`.
    expect(script.headers.get('access-control-allow-origin')).toBe('*')
    expect(await script.text()).toBe(SOURCE)
  })

  it('serves the stable name with an etag that revalidates', async () => {
    const t = serve()
    const first = await t.app.request('http://localhost:3430/gamemodes/powerup-dm/widget.js')
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-cache')
    expect(first.headers.get('etag')).toBe(`"${HASH}"`)
    expect(first.headers.get('access-control-allow-origin')).toBe('*')
    expect(await first.text()).toBe(SOURCE)
    const again = await t.app.request('http://localhost:3430/gamemodes/powerup-dm/widget.js', {
      headers: { 'if-none-match': `"${HASH}"` },
    })
    expect(again.status).toBe(304)
  })

  it('is 404 for a hash that is not this boot’s, a mode without a widget, and a mode that does not exist', async () => {
    const t = serve()
    for (const path of [
      `/gamemodes/powerup-dm/widget/${'0'.repeat(16)}/index.html`,
      `/gamemodes/powerup-dm/widget/${'0'.repeat(16)}/widget.js`,
      `/gamemodes/pug/widget/${HASH}/index.html`,
      '/gamemodes/pug/widget.js',
      '/gamemodes/nope/widget.js',
    ]) {
      const response = await t.app.request(`http://localhost:3430${path}`)
      expect(response.status, path).toBe(404)
    }
  })

  it('serves nothing when no bundles were composed', async () => {
    const t = createTestApp()
    const response = await t.app.request('http://localhost:3430/gamemodes/powerup-dm/widget.js')
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })
})

describe('widgetCsp', () => {
  it('names the hosts without a scheme and the socket with both', () => {
    expect(widgetCsp(['gs.ezpug.com', 'gs.ezpug.com', ''])).toBe(
      [
        "default-src 'none'",
        'script-src gs.ezpug.com',
        'connect-src gs.ezpug.com ws://gs.ezpug.com wss://gs.ezpug.com',
        "style-src 'unsafe-inline'",
        'img-src data: blob:',
        'font-src data:',
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    )
  })
})
