import { describe, expect, it } from 'vitest'
import { sanitiseWidgetTokens, WIDGET_TOKEN_FALLBACKS, WIDGET_TOKEN_NAMES } from './tokens'

/**
 * The names the platform's host injects (`/root/ezpug/packages/ui/src/widget.ts`,
 * `WIDGET_TOKEN_NAMES`), copied here on 2026-09-07. A name the host sends and
 * this table lacks would fall back to nothing inside the widget — which is
 * why the list is pinned and `docs/gamemodes.md` publishes it.
 */
const PLATFORM_NAMES = [
  '--ui-primary',
  '--ui-on-primary',
  '--ui-bg',
  '--ui-bg-muted',
  '--ui-bg-elevated',
  '--ui-bg-accented',
  '--ui-border',
  '--ui-border-muted',
  '--ui-border-accented',
  '--ui-text-dimmed',
  '--ui-text-muted',
  '--ui-text-toned',
  '--ui-text',
  '--ui-text-highlighted',
  '--ui-ct',
  '--ui-t',
  '--ui-live',
  '--ui-success',
  '--ui-info',
  '--ui-warning',
  '--ui-radius',
  '--ui-motion-hover',
  '--ui-motion-layout',
  '--ui-motion-media',
  '--font-sans',
  '--font-mono',
]

describe('the token table', () => {
  it('names exactly what the platform’s host injects, each with a fallback', () => {
    expect([...WIDGET_TOKEN_NAMES].sort()).toEqual([...PLATFORM_NAMES].sort())
    for (const name of WIDGET_TOKEN_NAMES) expect(WIDGET_TOKEN_FALLBACKS[name]).toMatch(/\S/)
  })

  it('keeps only custom-property names with short string values', () => {
    expect(
      sanitiseWidgetTokens({
        '--ui-text': '#fff',
        'ui-text': '#000',
        '--x': 7,
        '--long': 'a'.repeat(300),
        '--ok': 'b',
      }),
    ).toEqual({ '--ui-text': '#fff', '--ok': 'b' })
    expect(sanitiseWidgetTokens(null)).toEqual({})
    expect(sanitiseWidgetTokens('nope')).toEqual({})
  })
})
