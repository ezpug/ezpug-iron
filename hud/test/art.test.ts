import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ART_STYLES, artTexture, renderArtStyles } from '../src/art.ts'
import { DEFAULT_ART, hudKeys } from '../src/keys.ts'

const HUD = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('the moment’s pictures', () => {
  it('are the stylesheet the moment includes (`pnpm hud:keys` after adding one)', () => {
    expect(readFileSync(join(HUD, ART_STYLES), 'utf8')).toBe(
      renderArtStyles(hudKeys(HUD).art, DEFAULT_ART),
    )
  })

  it('show the empty sleeve unless the card carries a class for a key the addon holds', () => {
    const css = renderArtStyles(['big-jersey', 'category-merch', 'empty'], 'empty')
    const rules = [...css.matchAll(/^([.][^{\n]*)\n\{\n\tbackground-image: url\( "([^"]+)" \);/gm)]
    expect(rules.map(rule => [rule[1], rule[2]])).toEqual([
      ['.ezpug-moment-art', artTexture('empty')],
      ['.ezpug-moment-card.art-big-jersey .ezpug-moment-art', artTexture('big-jersey')],
      ['.ezpug-moment-card.art-category-merch .ezpug-moment-art', artTexture('category-merch')],
    ])
  })

  it('have one rule each, for the box the moment’s layout carries', () => {
    const css = readFileSync(join(HUD, ART_STYLES), 'utf8')
    const xml = readFileSync(join(HUD, 'layout/ezpug_moment.xml'), 'utf8')
    expect(css.match(/background-image/g)).toHaveLength(hudKeys(HUD).art.length)
    expect(xml).toContain('class="ezpug-moment-art"')
    expect(xml).toMatch(/<Panel id="moment_card" class="ezpug-moment-card"/)
    expect(xml).toContain('ezpug_art.vcss_c')
  })
})
