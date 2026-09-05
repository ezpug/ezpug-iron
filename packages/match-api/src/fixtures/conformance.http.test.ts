/// <reference types="node" />
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createMatchApiClient } from '../client'
import { createFakeConformanceTarget } from '../fake/conformance'
import type { ConformanceTarget } from './conformance'
import {
  formatConformanceReport,
  MATCH_API_CONFORMANCE_FLOWS,
  runMatchApiConformance,
} from './conformance'
import { describeMatchApiConformance } from './vitest'

/**
 * **The conformance suite over HTTP** (PRD-01 T8, the extended tier). The
 * same flows as `conformance.test.ts`, but every call is a real request to a
 * real port through the published client, and the stream is a real WebSocket
 * — so the route table's paths, methods, statuses, query strings and error
 * bodies are all exercised, not just the handlers behind them. This is the
 * shape PRD-02 points at the orchestrator: swap the target, keep the flows.
 *
 * The whole thing still runs on the fake clock, so eleven matches take about
 * a second.
 */

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

/** A fresh fake on a real port, driven by the published client. */
async function httpTarget(): Promise<ConformanceTarget> {
  const base = createFakeConformanceTarget()
  const listener = await base.fake.listen()
  const options = {
    baseUrl: listener.url,
    clock: base.clock,
    // A retry sleeps on the fake clock; nothing here answers 429, and a
    // suite that waited for one would only be waiting for itself.
    retry: false as const,
    WebSocket: WebSocket as unknown as NonNullable<
      Parameters<typeof createMatchApiClient>[0]['WebSocket']
    >,
  }
  const client = createMatchApiClient({ ...options, apiKey: base.platform.secret })
  const thrifty = createMatchApiClient({ ...options, apiKey: base.thrifty.secret })
  // The runner closes a factory's target itself; `afterEach` is the safety
  // net for a run that threw before it got there, so closing twice is normal.
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await listener.close()
    base.fake.close()
  }
  closers.push(close)

  return {
    ...base,
    client,
    budget: {
      client: thrifty,
      maxServerLifetimeMinutes: base.budget?.maxServerLifetimeMinutes ?? 60,
    },
    // A socket arrives on the event loop, not on the clock: give it a turn.
    advance: async ms => {
      await base.clock.advance(ms)
      await new Promise<void>(resolve => setImmediate(resolve))
    },
    settle: async () => {
      await base.fake.playOut()
      await new Promise<void>(resolve => setImmediate(resolve))
    },
    stream: (subscription, onFrame) => {
      const handle = client.subscribeStream({
        matchId: subscription.matchId,
        onFrame,
        ...(subscription.token === undefined ? {} : { token: subscription.token }),
      })
      return () => handle.close()
    },
    close,
  }
}

describeMatchApiConformance('the fake orchestrator over HTTP', { target: () => httpTarget() })

describe('the suite over HTTP', () => {
  it('agrees with the in-process run about every flow', async () => {
    const report = await runMatchApiConformance({ target: () => httpTarget() })
    expect(formatConformanceReport(report)).toContain('0 failed')
    expect(report.skipped).toBe(0)
    expect(report.passed).toBe(MATCH_API_CONFORMANCE_FLOWS.length)
  })
})
