import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compiledPath, sources, vtexFor } from '../src/addon.ts'
import { hudKeys } from '../src/keys.ts'

const HUD = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFileSync(join(HUD, path), 'utf8')
const layouts = readdirSync(join(HUD, 'layout')).map(f => `layout/${f}`)
const styles = readdirSync(join(HUD, 'styles')).map(f => `styles/${f}`)

describe('the addon mapping', () => {
  it('puts every source where the game and the server look for it', () => {
    const byPath = Object.fromEntries(sources(HUD).map(s => [s.source, s]))
    expect(byPath['layout/ezpug_welcome.xml']?.addonPath).toBe(
      'panorama/layout/custom_game/ezpug_welcome.xml',
    )
    expect(byPath['styles/ezpug_welcome.css']?.addonPath).toBe(
      'panorama/styles/custom_game/ezpug_welcome.css',
    )
    expect(byPath['images/cast/hello.png']).toEqual({
      source: 'images/cast/hello.png',
      addonPath: 'panorama/images/custom_game/ezpug/cast/hello.png',
      vtex: 'panorama/images/custom_game/ezpug/cast/hello.vtex',
    })
    expect(byPath['banners/default.png']).toEqual({
      source: 'banners/default.png',
      addonPath: 'panorama/images/custom_game/ezpug/banners/default.png',
      vtex: 'panorama/images/custom_game/ezpug/banners/default.vtex',
    })
    expect(byPath['layout/ezpug_moment.xml']?.addonPath).toBe(
      'panorama/layout/custom_game/ezpug_moment.xml',
    )
    expect(byPath['art/empty.png']).toEqual({
      source: 'art/empty.png',
      addonPath: 'panorama/images/custom_game/ezpug/art/empty.png',
      vtex: 'panorama/images/custom_game/ezpug/art/empty.vtex',
    })
    // Every picture the contract lists is in the addon under its own key.
    expect(
      sources(HUD)
        .filter(s => s.source.startsWith('art/'))
        .map(s => s.source.slice('art/'.length, -'.png'.length)),
    ).toEqual(hudKeys(HUD).art)
  })

  it('names the compiled file of each source', () => {
    const compiled = sources(HUD).map(compiledPath)
    expect(compiled).toContain('panorama/layout/custom_game/ezpug_welcome.vxml_c')
    expect(compiled).toContain('panorama/styles/custom_game/ezpug_welcome.vcss_c')
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

/** Every Panorama property a stylesheet here uses, each looked up in the client's list. Add one after looking it up. */
const PROPERTIES = [
  'background-color',
  'background-image',
  'background-position',
  'background-repeat',
  'background-size',
  'border',
  'border-radius',
  'color',
  'flow-children',
  'font-size',
  'font-weight',
  'height',
  'horizontal-align',
  'letter-spacing',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-height',
  'max-width',
  'opacity',
  'padding',
  'text-overflow',
  'text-transform',
  'transform',
  'transform-origin',
  'transition',
  'transition-delay',
  'transition-duration',
  'transition-property',
  'transition-timing-function',
  'vertical-align',
  'visibility',
  'white-space',
  'width',
]

describe('every stylesheet', () => {
  it.each(styles)('%s: keyframes quoted and never on transform; pictures from the addon', file => {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const frames of css.matchAll(/@keyframes\s+([^{\s]+)\s*\{([\s\S]*?\}\s*)\}/g)) {
      expect(frames[1]).toMatch(/^'[^']+'$/)
      expect(frames[2]).not.toMatch(/transform/)
    }
    // Valve's compiler takes any property and any value without a word (PRD-07 T5 tried
    // `bogus-property`, `box-shadow: none` and a comma selector), and a client drops
    // the rule or the whole layout. So every property here is one checked by hand against
    // the client's own list (`dump_panorama_css_properties`, panorama-hud's reference).
    for (const declaration of css.matchAll(/[{;]\s*([a-z-]+)\s*:/g))
      expect(PROPERTIES).toContain(declaration[1])
    // A comma selector is a layout that silently fails to load (cs2-ui-kit's GOTCHAS).
    for (const rule of css.matchAll(/(?:^|\})\s*([^{}@]+?)\s*\{/g))
      expect(rule[1]).not.toContain(',')
    for (const url of css.matchAll(/url\(\s*"([^"]+)"\s*\)/g))
      expect(url[1]).toMatch(
        /^s2r:\/\/panorama\/images\/(custom_game\/ezpug\/[a-z0-9_/-]+\.vtex|.+_png\.vtex)$/,
      )
  })
})

/** Our own class names in a text: everything `ezpug-`, which is every class a layout carries from the start. */
const ownClasses = (text: string, pattern: RegExp) =>
  new Set([...text.matchAll(pattern)].flatMap(match => match[1]!.split(/\s+/)).filter(Boolean))

// A class the layout carries and no rule styles, or a rule for a class no panel carries,
// is a typo the client draws as nothing. State classes the plugin sets (`shown`,
// `tier-rare`, `art-<key>`) are not `ezpug-` names and are held by the plugin's own tests.
describe('a layout and the stylesheets it includes', () => {
  it.each(layouts)('%s: name the same classes', file => {
    const xml = read(file).replace(/<!--[\s\S]*?-->/g, '')
    const carried = ownClasses(xml, /class="([^"]*)"/g)
    const styled = new Set<string>()
    for (const include of xml.matchAll(
      /<include src="s2r:\/\/panorama\/styles\/custom_game\/([a-z0-9_]+)\.vcss_c"/g,
    )) {
      const css = read(`styles/${include[1]}.css`).replace(/\/\*[\s\S]*?\*\//g, '')
      for (const selector of css.matchAll(/(?:^|\})\s*([^{}@]+?)\s*\{/g))
        for (const name of selector[1]!.matchAll(/\.(ezpug-[a-z0-9-]+)/g)) styled.add(name[1]!)
    }
    expect([...carried].sort()).toEqual([...styled].sort())
  })
})

describe('what a layout or a stylesheet names', () => {
  const compiled = new Set(sources(HUD).map(compiledPath))
  it.each([...layouts, ...styles])('%s: is in the addon', file => {
    const text = read(file)
    for (const include of text.matchAll(/<include src="s2r:\/\/([^"]+)"/g))
      expect(compiled).toContain(include[1])
    for (const url of text.matchAll(
      /url\(\s*"s2r:\/\/(panorama\/images\/custom_game\/[^"]+)"\s*\)/g,
    ))
      expect(compiled).toContain(`${url[1]}_c`)
  })
})
