import { describe, expect, it } from 'vitest'
import type { ChaosEvent } from './chaos'
import { createChaosController, parseChaosSpec } from './chaos'
import { createFakeClock } from './clock'
import { createPrng } from './prng'

function setup() {
  const clock = createFakeClock()
  const faults: ChaosEvent[] = []
  const sent: string[] = []
  const chaos = createChaosController({
    clock,
    prng: createPrng('chaos-test'),
    onFault: event => faults.push(event),
  })
  const send = (value: string) => () => {
    sent.push(value)
  }
  return { clock, chaos, faults, sent, send }
}

describe('chaos controller', () => {
  it('is a pass-through until something is configured', async () => {
    const { chaos, sent, send } = setup()
    expect(chaos.enabled()).toBe(false)

    await chaos.deliver({ target: 'socket.delta', key: 'wall:main' }, send('a'))
    expect(sent).toEqual(['a'])
    expect(chaos.describe().delivered).toBe(1)
  })

  it('drops exactly the scripted delivery and lets the next one through', async () => {
    const { chaos, sent, send, faults } = setup()
    chaos.script('socket.delta', [{ fault: 'drop' }])
    expect(chaos.enabled()).toBe(true)

    await chaos.deliver({ target: 'socket.delta' }, send('lost'))
    await chaos.deliver({ target: 'socket.delta' }, send('kept'))

    expect(sent).toEqual(['kept'])
    expect(faults).toEqual([
      { target: 'socket.delta', key: undefined, fault: 'drop', source: 'script' },
    ])
    expect(chaos.describe().applied.drop).toBe(1)
  })

  it('keeps a keyed step at the head until its own delivery shows up', async () => {
    const { chaos, sent, send } = setup()
    chaos.script('socket.delta', [{ fault: 'drop', key: 'wall:main' }])

    await chaos.deliver({ target: 'socket.delta', key: 'presence' }, send('presence'))
    await chaos.deliver({ target: 'socket.delta', key: 'wall:main' }, send('wall'))
    await chaos.deliver({ target: 'socket.delta', key: 'wall:main' }, send('wall-2'))

    expect(sent).toEqual(['presence', 'wall-2'])
    expect(chaos.describe().script).toEqual({})
  })

  it('applies a step `times` times', async () => {
    const { chaos, sent, send } = setup()
    chaos.script('socket', [{ fault: 'drop', times: 2 }])

    await chaos.deliver({ target: 'socket.delta' }, send('a'))
    await chaos.deliver({ target: 'socket.delta' }, send('b'))
    await chaos.deliver({ target: 'socket.delta' }, send('c'))

    expect(sent).toEqual(['c'])
  })

  it('delays on the injected clock, never a real timer', async () => {
    const { chaos, clock, sent, send } = setup()
    chaos.script('socket.delta', [{ fault: 'delay', delayMs: 400 }])

    await chaos.deliver({ target: 'socket.delta' }, send('late'))
    await chaos.deliver({ target: 'socket.delta' }, send('early'))
    // The delayed one has not run — and the caller was never blocked by it.
    expect(sent).toEqual(['early'])
    expect(chaos.describe().pending).toBe(1)

    await clock.advance(400)
    await chaos.settled()
    expect(sent).toEqual(['early', 'late'])
    expect(chaos.describe().pending).toBe(0)
  })

  it('duplicates a delivery', async () => {
    const { chaos, sent, send } = setup()
    chaos.script('bus.ephemeral', [{ fault: 'duplicate' }])

    await chaos.deliver({ target: 'bus.ephemeral', key: 'match.finished' }, send('fact'))

    expect(sent).toEqual(['fact', 'fact'])
  })

  it('skips a fault the call site does not tolerate, keeping the step queued', async () => {
    const { chaos, sent, send } = setup()
    chaos.script('bus.durable', [{ fault: 'drop' }])

    // A durable enqueue may be delayed or doubled, never dropped: the queue's
    // at-least-once promise is not ours to fake.
    await chaos.deliver(
      { target: 'bus.durable', faults: ['delay', 'duplicate'] },
      send('must-arrive'),
    )
    expect(sent).toEqual(['must-arrive'])
    expect(chaos.describe().applied.drop).toBe(0)
    expect(chaos.describe().script['bus.durable']).toHaveLength(1)
  })

  it('resolves the most specific configured scope', async () => {
    const { chaos, sent, send } = setup()
    chaos.configure('socket', { drop: 1 })
    chaos.configure('socket.delta', { drop: 0 })

    await chaos.deliver({ target: 'socket.delta' }, send('delta'))
    await chaos.deliver({ target: 'socket.snapshot' }, send('snapshot'))

    expect(sent).toEqual(['delta'])
  })

  it('rolls faults from the seeded prng — same seed, same run', async () => {
    async function run(): Promise<string[]> {
      const clock = createFakeClock()
      const sent: string[] = []
      const chaos = createChaosController({ clock, prng: createPrng('venue-wifi') })
      chaos.configure('socket', { drop: 0.3, duplicate: 0.2 })
      for (let i = 0; i < 40; i++) {
        await chaos.deliver({ target: 'socket.delta' }, () => {
          sent.push(`d${i}`)
        })
      }
      return sent
    }

    const first = await run()
    const second = await run()
    expect(first).toEqual(second)
    // Roughly half the deliveries are untouched, some vanish, some double.
    expect(first.length).toBeGreaterThan(20)
    expect(first.length).toBeLessThan(60)
    expect(new Set(first).size).toBeLessThan(40)
  })

  it('reports a throw from a delayed or duplicated send instead of losing it', async () => {
    const clock = createFakeClock()
    const errors: unknown[] = []
    const chaos = createChaosController({ clock, onError: error => errors.push(error) })
    chaos.script('socket.delta', [{ fault: 'delay', delayMs: 10 }])

    await chaos.deliver({ target: 'socket.delta' }, () => {
      throw new Error('emit failed')
    })
    await clock.advance(10)
    await chaos.settled()

    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('emit failed')
  })

  it('reset() clears profiles, scripts and counters', async () => {
    const { chaos, sent, send } = setup()
    chaos.configure('socket', { drop: 1 })
    await chaos.deliver({ target: 'socket.delta' }, send('gone'))
    chaos.reset()
    await chaos.deliver({ target: 'socket.delta' }, send('back'))

    expect(sent).toEqual(['back'])
    expect(chaos.describe()).toMatchObject({
      profiles: {},
      script: {},
      applied: { drop: 0, delay: 0, duplicate: 0 },
      delivered: 1,
    })
    expect(chaos.enabled()).toBe(false)
  })
})

describe('parseChaosSpec', () => {
  it('parses targets, faults, probabilities and delays', () => {
    expect(
      parseChaosSpec('socket:drop=0.05, socket.delta:delay=0.2@400,bus.ephemeral:duplicate=0.1'),
    ).toEqual({
      socket: { drop: 0.05 },
      'socket.delta': { delay: 0.2, delayMs: 400 },
      'bus.ephemeral': { duplicate: 0.1 },
    })
  })

  it('merges several faults for one target', () => {
    expect(parseChaosSpec('socket:drop=0.1,socket:duplicate=0.2')).toEqual({
      socket: { drop: 0.1, duplicate: 0.2 },
    })
  })

  it('refuses a typo instead of silently disabling chaos', () => {
    expect(() => parseChaosSpec('socket:drops=0.1')).toThrow(/cannot parse/)
    expect(() => parseChaosSpec('Socket:drop=0.1')).toThrow(/cannot parse/)
    expect(() => parseChaosSpec('socket:drop=2')).toThrow(/between 0 and 1/)
  })

  it('ignores empty entries and whitespace', () => {
    expect(parseChaosSpec('  ')).toEqual({})
    expect(parseChaosSpec('socket:drop=1,')).toEqual({ socket: { drop: 1 } })
  })
})
