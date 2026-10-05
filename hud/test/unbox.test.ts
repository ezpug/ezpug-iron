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

/** Every rule of the sheet: its selector and its declarations, in order. */
const rules = [...css.matchAll(/([^{}]+?)\s*\{([^}]*)\}/g)].map(match => ({
  selector: match[1]!.trim(),
  declarations: Object.fromEntries(
    [...match[2]!.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map(d => [d[1]!, d[2]!.trim()]),
  ) as Record<string, string>,
}))

/** One rule's declarations, by its exact selector. */
function rule(selector: string): Record<string, string> {
  const found = rules.find(r => r.selector === selector)
  if (!found) throw new Error(`no rule for ${selector}`)
  return found.declarations
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
// goes in slot 33 because that is the slot the 29th step stops on, and every step is a
// class the plugin sets. A width changed on one side and not the other stops the reel
// on a decoy.
const SLOTS = 36
const REST_SLOT = 4
const STOP_SLOT = 33
const STEPS = STOP_SLOT - REST_SLOT
const LANDINGS = 4

/** The transition longhands: the four Panorama animates a change by. */
const TRANSITION = [
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
]

/** A selector is a panel's own rule when it names one class and no state (`.ezpug-unbox-strip`, never `.ezpug-unbox.at-1 .ezpug-unbox-strip`). */
const isOwnRule = (selector: string) => /^\.ezpug-[a-z-]+$/.test(selector)

/** The old slide, kept for `ezpug_unbox_test slide`: the one place a state may carry a transition. */
const isSlide = (selector: string) => selector.startsWith('.ezpug-unbox.slide')

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

  it('stands with slot 4 under the marker, and step k puts slot 4 + k there, the 29th slot 33', () => {
    const rest = translateX(rule('.ezpug-unbox-strip').transform)
    expect(centre(REST_SLOT, rest)).toBe(window / 2)
    expect(rest).toBeLessThanOrEqual(0)
    for (let k = 1; k <= STEPS; k++) {
      const at = translateX(rule(`.ezpug-unbox.at-${k} .ezpug-unbox-strip`).transform)
      expect(centre(REST_SLOT + k, at)).toBe(window / 2)
      // Standing or stepped, the strip covers the whole window: no empty end shows.
      expect(at + SLOTS * pitch).toBeGreaterThanOrEqual(window)
    }
    expect(
      centre(STOP_SLOT, translateX(rule(`.ezpug-unbox.at-${STEPS} .ezpug-unbox-strip`).transform)),
    ).toBe(window / 2)
    // No step past the prize, and none the layout could not show.
    expect(rules.filter(r => /^\.ezpug-unbox\.at-\d+ /.test(r.selector))).toHaveLength(STEPS)
  })

  it('lands a little off the centre, never off the picture, and settles back in a third of a second', () => {
    const rolled = translateX(rule(`.ezpug-unbox.at-${STEPS} .ezpug-unbox-strip`).transform)
    for (let n = 1; n <= LANDINGS; n++) {
      const landing = translateX(rule(`.ezpug-unbox.land-${n} .ezpug-unbox-land`).transform)
      expect(rolled + landing).toBeLessThanOrEqual(0)
      expect(rolled + landing + SLOTS * pitch).toBeGreaterThanOrEqual(window)
      expect(Math.abs(landing)).toBeLessThan(px(rule('.ezpug-unbox-slot-art').width) / 2)
      expect(landing).not.toBe(0)
    }
    expect(seconds(rule('.ezpug-unbox-land')['transition-duration'])).toBeLessThanOrEqual(300)
  })

  // The playtests of 2026-10-04 and 2026-10-05 (docs/hud.md, "The unboxing, drawn"): the
  // strip's own rule said 0 s and the class that started the roll said 6 s, and on a real
  // client the strip jumped and sat. The landing's settle, 0.3 s on its own rule, was
  // smooth. Valve's own reel declares its 6 s on the panel's rule. So: what animates is
  // declared where the panel is, and a state changes only the target.
  it('declares every transition on a panel’s own rule; a state changes only the target', () => {
    let own = 0
    for (const { selector, declarations } of rules) {
      const named = TRANSITION.filter(longhand => longhand in declarations)
      if (isOwnRule(selector)) {
        // A panel that animates says all four, so nothing is left to the state's choosing.
        if (named.length > 0) {
          expect(named, selector).toEqual(TRANSITION)
          own++
        }
        continue
      }
      if (isSlide(selector)) continue
      expect(named, `${selector} carries a transition; put it on the panel's own rule`).toEqual([])
      expect(declarations).not.toHaveProperty('transition')
    }
    expect(own).toBeGreaterThanOrEqual(8)
    expect(css).not.toMatch(/@keyframes|animation-name/)
  })

  it('steps in short slides the strip’s own rule animates, quick enough to keep up with the ticks', () => {
    const strip = rule('.ezpug-unbox-strip')
    expect(strip['transition-property']).toBe('transform')
    const step = seconds(strip['transition-duration'])
    expect(step).toBeGreaterThanOrEqual(100)
    // Shorter than the slowest readable gap between two steps, so a step is over before
    // the next one, and the strip never lags a slot behind the ticks at the end.
    expect(step).toBeLessThanOrEqual(250)
    expect(seconds(strip['transition-delay'])).toBe(0)
    for (let k = 1; k <= STEPS; k++) {
      const at = rule(`.ezpug-unbox.at-${k} .ezpug-unbox-strip`)
      expect(Object.keys(at)).toEqual(['transform'])
    }
  })

  it('keeps the old slide for the diagnostic only: started by `slide`, never by a step', () => {
    const slide = rule('.ezpug-unbox.slide .ezpug-unbox-strip')
    expect(seconds(slide['transition-duration'])).toBe(6000)
    expect(slide['transition-timing-function']).toMatch(/^cubic-bezier\(/)
    expect(translateX(slide.transform)).toBe(
      translateX(rule(`.ezpug-unbox.at-${STEPS} .ezpug-unbox-strip`).transform),
    )
    for (let n = 1; n <= LANDINGS; n++) {
      const landing = rule(`.ezpug-unbox.slide.land-${n} .ezpug-unbox-land`)
      expect(seconds(landing['transition-duration'])).toBe(6000)
      expect(landing.transform).toBe(rule(`.ezpug-unbox.land-${n} .ezpug-unbox-land`).transform)
    }
    expect(rules.filter(r => isSlide(r.selector))).toHaveLength(1 + LANDINGS)
    expect(css).not.toMatch(/\.rolling\b/)
  })

  it('is put away at once, and the strip is back before the next unboxing may begin', () => {
    const panel = rule('.ezpug-unbox')
    const fade = seconds(panel['transition-duration']) + seconds(panel['transition-delay'])
    expect(fade).toBeLessThanOrEqual(150)
    expect(Object.keys(rule('.ezpug-unbox.shown'))).toEqual(['opacity', 'transform'])
    // The plugin takes the step class off 0.2 s after the fade (Moments.StripBackMs); the
    // strip's own slide is over well inside the half second before the next reel.
    expect(seconds(rule('.ezpug-unbox-strip')['transition-duration'])).toBeLessThanOrEqual(250)
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

  it('carries the build stamp in the reel’s window, small and quiet', () => {
    expect(xml).toMatch(/<Label class="ezpug-unbox-stamp" hittest="false" text="[0-9a-f]{7}" \/>/)
    const stamp = rule('.ezpug-unbox-stamp')
    expect(px(stamp['font-size'])).toBeLessThanOrEqual(12)
    expect(stamp.color).toMatch(/^#[0-9a-f]{6}[0-9a-f]{2}$/)
  })
})
