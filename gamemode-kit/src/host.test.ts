import { createFakeClock } from '@ezpug/core'
import { describe, expect, it } from 'vitest'
import { connectToHost, type HostPort } from './host'

/**
 * The handshake without a browser: a plain `EventTarget` stands in for the
 * window, a recording `parent` for the host frame, and the messages are
 * dispatched with the `origin` and `source` a browser would stamp.
 */

function rig(options: { readyEveryMs?: number; orphanAfterMs?: number } = {}) {
  const clock = createFakeClock()
  const target = new EventTarget()
  const posted: { message: unknown; origin: string }[] = []
  const parent: HostPort = {
    postMessage: (message, origin) => void posted.push({ message, origin }),
  }
  const shell = connectToHost({ target, parent, clock, ...options })
  const arrive = (data: unknown, origin = 'https://ezpug.com', source: unknown = HOST) => {
    target.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }))
  }
  return { clock, shell, posted, arrive }
}

const HOST = { tag: 'host window' }
const INIT = {
  type: 'ezpug.widget.init',
  protocol: 1,
  orchestratorUrl: 'https://gs.ezpug.com',
  matchId: 'match-1',
  locale: 'en',
  tokens: { '--ui-text': '#fff', bogus: 'x' },
  playerToken: 'ezip_abcdefghijklmnopqrstuvwxyz0123456789',
}

describe('connectToHost', () => {
  it('posts ready to anyone, repeats it until init, then pins the origin', async () => {
    const { clock, shell, posted, arrive } = rig()
    expect(posted).toEqual([{ message: { type: 'ezpug.widget.ready', protocol: 1 }, origin: '*' }])
    await clock.advance(1_000)
    expect(posted).toHaveLength(2)
    arrive(INIT)
    expect(shell.state.value).toEqual({
      status: 'ready',
      orchestratorUrl: 'https://gs.ezpug.com',
      matchId: 'match-1',
      locale: 'en',
      tokens: { '--ui-text': '#fff' },
      playerToken: INIT.playerToken,
    })
    await clock.advance(5_000)
    expect(posted).toHaveLength(2)
    shell.reportSize(123.4)
    expect(posted.at(-1)).toEqual({
      message: { type: 'ezpug.widget.size', height: 123 },
      origin: 'https://ezpug.com',
    })
    shell.reportError('nope')
    expect(posted.at(-1)?.message).toEqual({ type: 'ezpug.widget.error', message: 'nope' })
    shell.dispose()
  })

  it('ignores a message that is not a valid init before pinning, and any other origin after', () => {
    const { shell, arrive } = rig()
    arrive({ type: 'ezpug.widget.init', protocol: 2, orchestratorUrl: 'x' }, 'https://evil.invalid')
    arrive({ type: 'ezpug.widget.tokens', tokens: { '--ui-text': 'red' } })
    expect(shell.state.value.status).toBe('waiting')
    arrive(INIT)
    arrive({ type: 'ezpug.widget.tokens', tokens: { '--ui-text': 'red' } }, 'https://evil.invalid')
    arrive({ type: 'ezpug.widget.tokens', tokens: { '--ui-text': 'red' } }, 'https://ezpug.com', {
      tag: 'other window',
    })
    expect(shell.state.value.tokens).toEqual({ '--ui-text': '#fff' })
    arrive({ type: 'ezpug.widget.tokens', tokens: { '--ui-text': 'red' } })
    expect(shell.state.value.tokens).toEqual({ '--ui-text': 'red' })
    arrive({ ...INIT, playerToken: null, locale: 'de' })
    expect(shell.state.value.playerToken).toBeNull()
    expect(shell.state.value.locale).toBe('de')
    shell.dispose()
  })

  it('says orphan after the silence budget, and nothing is posted to nobody', async () => {
    const { clock, shell, posted } = rig({ orphanAfterMs: 3_000 })
    shell.reportSize(10)
    expect(
      posted.filter(p => (p.message as { type: string }).type === 'ezpug.widget.size'),
    ).toEqual([])
    await clock.advance(3_000)
    expect(shell.state.value.status).toBe('orphan')
    shell.dispose()
    const before = posted.length
    await clock.advance(10_000)
    expect(posted).toHaveLength(before)
  })
})
