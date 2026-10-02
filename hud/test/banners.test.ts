import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BANNER_HEIGHT,
  BANNER_STYLES,
  BANNER_WIDTH,
  bannerTexture,
  renderBannerStyles,
} from '../src/banners.ts'
import { DEFAULT_BANNER, hudKeys } from '../src/keys.ts'
import { pngSize } from '../src/readback.ts'

const HUD = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('the welcome’s banners', () => {
  it('are the stylesheet the welcome includes (`pnpm hud:keys` after adding one)', () => {
    expect(readFileSync(join(HUD, BANNER_STYLES), 'utf8')).toBe(
      renderBannerStyles(hudKeys(HUD).banners, DEFAULT_BANNER),
    )
  })

  it('are each the banner’s size, the house one too (`pnpm hud:banner` fits any picture)', () => {
    for (const file of readdirSync(join(HUD, 'banners')))
      expect([file, pngSize(readFileSync(join(HUD, 'banners', file)))]).toEqual([
        file,
        { width: BANNER_WIDTH, height: BANNER_HEIGHT },
      ])
  })

  it('show the house banner unless the welcome carries a class for a key the addon holds', () => {
    const css = renderBannerStyles(['default', 'saarlan-2026'], 'default')
    const rules = [...css.matchAll(/^([.][^{\n]*)\n\{\n\tbackground-image: url\( "([^"]+)" \);/gm)]
    expect(rules.map(rule => [rule[1], rule[2]])).toEqual([
      ['.ezpug-welcome-banner', bannerTexture('default')],
      ['.ezpug-welcome.banner-saarlan-2026 .ezpug-welcome-banner', bannerTexture('saarlan-2026')],
    ])
  })
})
