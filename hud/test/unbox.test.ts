import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HUD = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const xml = readFileSync(join(HUD, 'layout/ezpug_moment.xml'), 'utf8').replace(
  /<!--[\s\S]*?-->/g,
  '',
)
const css = readFileSync(join(HUD, 'styles/ezpug_unbox.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

/** One rule's declarations, by its exact selector. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`no rule for ${selector}`)
  return Object.fromEntries(
    [...match[1]!.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map(d => [d[1]!, d[2]!.trim()]),
  )
}

const px = (value: string | undefined) => {
  const match = value?.match(/^(-?\d+)px$/)
  if (!match) throw new Error(`not a length in px: ${value}`)
  return Number(match[1])
}
const translateX = (value: string | undefined) => {
  const match = value?.match(/^translate3d\( (-?\d+)px, 0px, 0px \)$/)
  if (!match) throw new Error(`not a sideways translate: ${value}`)
  return Number(match[1])
}
const seconds = (value: string | undefined) => {
  const match = value?.match(/^([\d.]+)s$/)
  if (!match) throw new Error(`not a duration: ${value}`)
  return Number(match[1]) * 1000
}

// The numbers the stylesheet's header promises, and that the plugin builds on: the prize
// goes in slot 33 because that is the slot the reel stops on, and a tick is timed by the
// curve below. A width changed on one side and not the other stops the reel on a decoy.
const SLOTS = 36
const REST_SLOT = 4
const STOP_SLOT = 33
const REEL_MS = 6000
const CURVE = 'cubic-bezier( 0.08, 0.6, 0.12, 1 )'
const LANDINGS = 4

describe('the unboxing’s reel', () => {
  const slot = rule('.ezpug-unbox-slot')
  const margins = slot.margin!.split(/\s+/).map(px)
  const pitch = px(slot.width) + margins[1]! + margins[3]!
  const window = px(rule('.ezpug-unbox-window').width)
  /** Where the centre of slot k (from 1) is, against the window's left edge, with the strip at x. */
  const centre = (k: number, x: number) => x + pitch * (k - 1) + pitch / 2

  it('has its slots, in order, each with a picture box and a tint', () => {
    const ids = [...xml.matchAll(/<Panel id="(unbox_slot_\d+)" class="ezpug-unbox-slot"/g)].map(
      m => m[1],
    )
    expect(ids).toEqual(Array.from({ length: SLOTS }, (_, i) => `unbox_slot_${i + 1}`))
    expect(xml.match(/class="ezpug-unbox-slot-art"/g)).toHaveLength(SLOTS)
    expect(xml.match(/class="ezpug-unbox-slot-tier"/g)).toHaveLength(SLOTS)
  })

  it('is as wide as its slots, and the window clips it', () => {
    expect(pitch).toBe(140)
    expect(px(rule('.ezpug-unbox-strip').width)).toBe(SLOTS * pitch)
    expect(px(rule('.ezpug-unbox-land').width)).toBe(SLOTS * pitch)
    expect(rule('.ezpug-unbox-window').overflow).toBe('clip clip')
    expect(rule('.ezpug-unbox-marker')['horizontal-align']).toBe('center')
  })

  it('stands with slot 4 under the marker and stops with slot 33 there', () => {
    const rest = translateX(rule('.ezpug-unbox-strip').transform)
    const rolled = translateX(rule('.ezpug-unbox.rolling .ezpug-unbox-strip').transform)
    expect(centre(REST_SLOT, rest)).toBe(window / 2)
    expect(centre(STOP_SLOT, rolled)).toBe(window / 2)
    // Standing or stopped, the strip covers the whole window: no empty end shows.
    expect(rest).toBeLessThanOrEqual(0)
    for (let n = 1; n <= LANDINGS; n++) {
      const landing = translateX(rule(`.ezpug-unbox.rolling.land-${n} .ezpug-unbox-land`).transform)
      expect(rolled + landing).toBeLessThanOrEqual(0)
      expect(rolled + landing + SLOTS * pitch).toBeGreaterThanOrEqual(window)
      // Off the centre, but never off the picture: the marker stays inside the prize's box.
      expect(Math.abs(landing)).toBeLessThan(px(rule('.ezpug-unbox-slot-art').width) / 2)
    }
  })

  it('slides on one curve for 6 s, the landing with it, and settles in a third of a second', () => {
    const slides = [
      rule('.ezpug-unbox.rolling .ezpug-unbox-strip'),
      ...Array.from({ length: LANDINGS }, (_, i) =>
        rule(`.ezpug-unbox.rolling.land-${i + 1} .ezpug-unbox-land`),
      ),
    ]
    for (const slide of slides) {
      expect(slide['transition-property']).toBe('transform')
      expect(seconds(slide['transition-duration'])).toBe(REEL_MS)
      expect(slide['transition-timing-function']).toBe(CURVE)
      expect(seconds(slide['transition-delay'])).toBe(0)
    }
    const settle = rule('.ezpug-unbox-land')
    expect(seconds(settle['transition-duration'])).toBeLessThanOrEqual(300)
  })

  it('is put away at once, and the strip goes back only once nobody sees it', () => {
    const panel = rule('.ezpug-unbox')
    const fade = seconds(panel['transition-duration']) + seconds(panel['transition-delay'])
    expect(fade).toBeLessThanOrEqual(150)
    const back = rule('.ezpug-unbox-strip')
    expect(seconds(back['transition-duration'])).toBe(0)
    expect(seconds(back['transition-delay'])).toBeGreaterThan(fade)
  })

  it('stays for the buy menu, smaller and above its columns, and steps aside for the rest', () => {
    expect(rule('.HUD_BUYMENU_VISIBLE .ezpug-unbox-body').transform).toMatch(/scale3d/)
    expect(css).not.toMatch(/\.HUD_BUYMENU_VISIBLE \.ezpug-unbox(-body)?\s*\{[^}]*opacity: 0/)
    for (const screen of [
      'HUD_SCOREBOARD_VISIBLE',
      'HUD_TEAMINTRO_VISIBLE',
      'HUD_ENDOFMATCH_VISIBLE',
    ])
      expect(rule(`.${screen} .ezpug-unbox-body`).opacity).toBe('0')
    // It is outside the moment's own panel, which fades for the buy menu.
    const moment = xml.indexOf('<Panel class="ezpug-moment"')
    const unbox = xml.indexOf('<Panel id="unbox" class="ezpug-unbox"')
    expect(moment).toBeGreaterThan(-1)
    expect(unbox).toBeGreaterThan(xml.indexOf('<Panel id="moment_card"'))
  })

  it('tints and sizes the reveal by tier, and only once revealed', () => {
    const tiers = ['common', 'uncommon', 'rare', 'legendary']
    const bursts = tiers.map(
      tier => rule(`.ezpug-unbox.revealed.tier-${tier} .ezpug-unbox-burst`).transform,
    )
    const sizes = bursts.map(b => Number(b?.match(/^scale3d\( ([\d.]+),/)?.[1]))
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
    expect(new Set(sizes).size).toBe(tiers.length)
    expect(rule('.ezpug-unbox-burst').opacity).toBe('0')
    expect(rule('.ezpug-unbox-prize').opacity).toBe('0')
    for (const tier of tiers) {
      rule(`.ezpug-unbox-slot.tier-${tier}`)
      rule(`.ezpug-unbox-slot.tier-${tier} .ezpug-unbox-slot-tier`)
    }
  })
})
