import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compiledPath, sources, vtexFor } from '../src/addon.ts'

const HUD = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFileSync(join(HUD, path), 'utf8')
const layouts = readdirSync(join(HUD, 'layout')).map(f => `layout/${f}`)
const styles = readdirSync(join(HUD, 'styles')).map(f => `styles/${f}`)

describe('the addon mapping', () => {
  it('puts every source where the game and the server look for it', () => {
    const byPath = Object.fromEntries(sources(HUD).map(s => [s.source, s]))
    expect(byPath['layout/ezpug_hello.xml']?.addonPath).toBe(
      'panorama/layout/custom_game/ezpug_hello.xml',
    )
    expect(byPath['styles/ezpug_hello.css']?.addonPath).toBe(
      'panorama/styles/custom_game/ezpug_hello.css',
    )
    expect(byPath['images/cast/hello.png']).toEqual({
      source: 'images/cast/hello.png',
      addonPath: 'panorama/images/custom_game/ezpug/cast/hello.png',
      vtex: 'panorama/images/custom_game/ezpug/cast/hello.vtex',
    })
  })

  it('names the compiled file of each source', () => {
    const compiled = sources(HUD).map(compiledPath)
    expect(compiled).toContain('panorama/layout/custom_game/ezpug_hello.vxml_c')
    expect(compiled).toContain('panorama/styles/custom_game/ezpug_hello.vcss_c')
    expect(compiled).toContain('panorama/images/custom_game/ezpug/cast/hello.vtex_c')
  })

  it('compiles pictures uncompressed (DXT5 is pink on blue in a custom HUD)', () => {
    const vtex = vtexFor('panorama/images/custom_game/ezpug/x.png')
    expect(vtex).toContain('"m_outputFormat" "string" "BGRA8888"')
    expect(vtex).toContain('"m_fileName" "string" "panorama/images/custom_game/ezpug/x.png"')
  })
})

// The Findings of ralph/PRD-07-hud.md and cs2-ui-kit's GOTCHAS, each a silent
// failure on a client nobody here can see, so each is a red test instead.
describe('every layout', () => {
  it.each(layouts)(
    '%s: an ezpug_ name, a root panel without an id, no inline style, no <Image>, nothing that takes the mouse',
    file => {
      const xml = read(file).replace(/<!--[\s\S]*?-->/g, '')
      expect(file).toMatch(/^layout\/ezpug_[a-z0-9_]+\.xml$/)
      const root = xml.match(/<\/styles>\s*<(\w+)([^>]*)>/)
      expect(root?.[1]).toBe('Panel')
      expect(root?.[2]).not.toMatch(/\bid=/)
      expect(xml).not.toMatch(/\sstyle=/)
      expect(xml).not.toMatch(/<Image\b/)
      expect(xml).not.toMatch(/<scripts?\b/i)
      expect(xml).not.toMatch(/hittest="true"/)
      for (const tag of xml.matchAll(/<([A-Z]\w*)/g))
        expect(['Panel', 'Label', 'Button']).toContain(tag[1])
      for (const include of xml.matchAll(/<include src="([^"]+)"/g))
        expect(include[1]).toMatch(
          /^s2r:\/\/panorama\/styles\/custom_game\/ezpug_[a-z0-9_]+\.vcss_c$/,
        )
    },
  )
})

describe('every stylesheet', () => {
  it.each(styles)('%s: keyframes quoted and never on transform; pictures from the addon', file => {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const frames of css.matchAll(/@keyframes\s+([^{\s]+)\s*\{([\s\S]*?\}\s*)\}/g)) {
      expect(frames[1]).toMatch(/^'[^']+'$/)
      expect(frames[2]).not.toMatch(/transform/)
    }
    for (const url of css.matchAll(/url\(\s*"([^"]+)"\s*\)/g))
      expect(url[1]).toMatch(
        /^s2r:\/\/panorama\/images\/(custom_game\/ezpug\/[a-z0-9_/]+\.vtex|.+_png\.vtex)$/,
      )
  })
})
