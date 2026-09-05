import { useFakeClock } from '@ezpug/core/testing'
import { describe, expect, it } from 'vitest'
import { createMemoryLog } from './log'
import { createShutdown, type SignalSource } from './shutdown'

const clock = useFakeClock()

function fakeSignals() {
  const listeners = new Map<string, (() => void)[]>()
  const source: SignalSource = {
    once: (signal, listener) => {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener])
    },
    off: (signal, listener) => {
      listeners.set(
        signal,
        (listeners.get(signal) ?? []).filter(l => l !== listener),
      )
    },
  }
  const fire = (signal: string): void => {
    const [first, ...rest] = listeners.get(signal) ?? []
    listeners.set(signal, rest)
    first?.()
  }
  return { source, fire, armed: (signal: string) => (listeners.get(signal) ?? []).length }
}

describe('createShutdown', () => {
  it('runs the steps one at a time, in the order declared', async () => {
    const order: string[] = []
    const log = createMemoryLog()
    const shutdown = createShutdown({
      clock,
      log,
      steps: [
        { name: 'health', run: () => void order.push('health') },
        {
          name: 'listener',
          run: async () => {
            await clock.sleep(10)
            order.push('listener')
          },
        },
        { name: 'database', run: () => void order.push('database') },
      ],
    })
    expect(shutdown.draining).toBe(false)
    const drained = shutdown.drain('SIGTERM')
    expect(shutdown.draining).toBe(true)
    // Let the first step settle before time moves: `drain` is synchronous up
    // to its first await, the sleep is armed a microtask later.
    await clock.advance(0)
    await clock.advance(10)
    const result = await drained
    expect(order).toEqual(['health', 'listener', 'database'])
    expect(result).toMatchObject({ signal: 'SIGTERM', timedOut: false, code: 0 })
    expect(result.steps.map(step => step.name)).toEqual(['health', 'listener', 'database'])
    expect(log.lines).toContain('info drained listener')
  })

  it('continues past a step that throws and reports it in the exit code', async () => {
    const order: string[] = []
    const shutdown = createShutdown({
      clock,
      log: createMemoryLog(),
      steps: [
        {
          name: 'redis',
          run: () => {
            throw new Error('refuses to close')
          },
        },
        { name: 'database', run: () => void order.push('database') },
      ],
    })
    const result = await shutdown.drain('SIGTERM')
    expect(order).toEqual(['database'])
    expect(result.steps).toEqual([
      { name: 'redis', ok: false, error: expect.any(Error) },
      { name: 'database', ok: true },
    ])
    expect(result.code).toBe(1)
  })

  it('abandons a wedged step at the deadline and skips the rest', async () => {
    const order: string[] = []
    const shutdown = createShutdown({
      clock,
      log: createMemoryLog(),
      timeoutMs: 1_000,
      steps: [
        { name: 'listener', run: () => void order.push('listener') },
        { name: 'wedged', run: () => new Promise(() => {}) },
        { name: 'database', run: () => void order.push('database') },
      ],
    })
    const drained = shutdown.drain('SIGTERM')
    await clock.advance(0)
    await clock.advance(1_000)
    const result = await drained
    expect(order).toEqual(['listener'])
    expect(result.timedOut).toBe(true)
    expect(result.code).toBe(1)
    expect(result.steps.map(step => step.name)).toEqual(['listener'])
  })

  it('answers a second drain with the first one', async () => {
    let runs = 0
    const shutdown = createShutdown({
      clock,
      log: createMemoryLog(),
      steps: [
        {
          name: 'once',
          run: () => {
            runs += 1
          },
        },
      ],
    })
    const [a, b] = await Promise.all([shutdown.drain('SIGTERM'), shutdown.drain('SIGINT')])
    expect(runs).toBe(1)
    expect(a).toBe(b)
  })

  it('arms the signals, drains on the first and exits at once on the second', async () => {
    const signals = fakeSignals()
    const exits: number[] = []
    const shutdown = createShutdown({
      clock,
      log: createMemoryLog(),
      steps: [{ name: 'slow', run: () => clock.sleep(5_000) }],
      source: signals.source,
      exit: code => void exits.push(code),
    })
    const disarm = shutdown.listen()
    expect(signals.armed('SIGTERM')).toBe(1)
    signals.fire('SIGTERM')
    expect(shutdown.draining).toBe(true)
    // Re-armed, so the next one is the impatient one.
    expect(signals.armed('SIGTERM')).toBe(1)
    signals.fire('SIGTERM')
    expect(exits).toEqual([1])
    await clock.advance(5_000)
    await clock.advance(0)
    expect(exits).toEqual([1, 0])
    disarm()
    expect(signals.armed('SIGINT')).toBe(0)
  })
})
