// @vitest-environment happy-dom
import { createFakeClock } from '@ezpug/core'
import { eventually } from '@ezpug/core/testing'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { useWidget } from './context'
import { defineWidgetElement, WIDGET_TAG } from './element'
import type { HostPort } from './host'
import { mountWidget } from './mount'
import { WIDGET_TOKEN_FALLBACKS } from './tokens'

/**
 * The element in `happy-dom`: defined once, its attributes are its props,
 * the kit's context reaches the component, the tokens land on the host with
 * their fallbacks, and the shell's handshake drives all of it.
 */

const Probe = defineComponent({
  setup() {
    const { t, locale, link, matchId, playerToken } = useWidget()
    return () =>
      h('div', { class: 'probe' }, [
        h('span', { class: 'line' }, t.value({ de: 'Hallo', en: 'Hello' })),
        h('span', { class: 'locale' }, locale.value),
        h('span', { class: 'state' }, link.state.value),
        h('span', { class: 'match' }, matchId.value ?? '-'),
        h('span', { class: 'token' }, playerToken.value ? 'token' : 'none'),
      ])
  },
})

const clock = createFakeClock()
const Element = defineWidgetElement(Probe, { clock })

function text(el: Element, selector: string): string | undefined {
  return el.shadowRoot?.querySelector(selector)?.textContent ?? undefined
}

describe('the element', () => {
  it('is defined once under its tag and maps attributes to the context', async () => {
    expect(customElements.get(WIDGET_TAG)).toBe(Element)
    expect(defineWidgetElement(Probe, { clock })).not.toBe(Element)
    expect(customElements.get(WIDGET_TAG)).toBe(Element)

    const el = document.createElement(WIDGET_TAG)
    el.setAttribute('locale', 'en')
    el.setAttribute('match-id', 'match-7')
    document.body.appendChild(el)
    await nextTick()
    await eventually(() => expect(text(el, '.line')).toBe('Hello'))
    expect(text(el, '.locale')).toBe('en')
    expect(text(el, '.match')).toBe('match-7')
    expect(text(el, '.token')).toBe('none')
    expect(text(el, '.state')).toBe('watching')

    el.setAttribute('locale', 'de')
    await eventually(() => expect(text(el, '.line')).toBe('Hallo'))
    el.remove()
  })
})

describe('mountWidget', () => {
  it('creates the element, applies fallback tokens, and follows the host’s init and tokens', async () => {
    const posted: unknown[] = []
    const parent: HostPort = { postMessage: message => void posted.push(message) }
    const mounted = mountWidget(Element, { parent, target: window, clock })
    const el = mounted.element
    expect(document.body.contains(el)).toBe(true)
    expect(el.style.getPropertyValue('--ui-text')).toBe(WIDGET_TOKEN_FALLBACKS['--ui-text'])
    expect(el.style.getPropertyValue('--font-sans')).toBe(WIDGET_TOKEN_FALLBACKS['--font-sans'])
    expect(posted).toEqual([{ type: 'ezpug.widget.ready', protocol: 1 }])

    window.dispatchEvent(
      Object.assign(new Event('message'), {
        origin: 'https://ezpug.com',
        source: null,
        data: {
          type: 'ezpug.widget.init',
          protocol: 1,
          orchestratorUrl: 'https://gs.ezpug.com',
          matchId: 'match-9',
          locale: 'en',
          tokens: { '--ui-text': '#123456' },
          playerToken: null,
        },
      }),
    )
    await eventually(() => expect(text(el, '.match')).toBe('match-9'))
    expect(text(el, '.locale')).toBe('en')
    expect(text(el, '.token')).toBe('none')
    expect(text(el, '.state')).toBe('watching')
    expect(el.style.getPropertyValue('--ui-text')).toBe('#123456')
    expect(el.style.getPropertyValue('--ui-bg')).toBe(WIDGET_TOKEN_FALLBACKS['--ui-bg'])

    window.dispatchEvent(
      Object.assign(new Event('message'), {
        origin: 'https://ezpug.com',
        source: null,
        data: { type: 'ezpug.widget.tokens', tokens: { '--ui-text': '#654321' } },
      }),
    )
    await eventually(() => expect(el.style.getPropertyValue('--ui-text')).toBe('#654321'))
    mounted.dispose()
    el.remove()
  })
})
