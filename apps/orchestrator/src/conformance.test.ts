import type { ApiKeyCreated, WebhookEnvelope } from '@ezpug/match-api'
import { createMatchApiClient } from '@ezpug/match-api/client'
import {
  type ConformanceTarget,
  formatConformanceReport,
  MATCH_API_CONFORMANCE_FLOWS,
  runMatchApiConformance,
} from '@ezpug/match-api/fixtures'
import { describeMatchApiConformance } from '@ezpug/match-api/fixtures/vitest'
import { verifyWebhook } from '@ezpug/match-api/webhooks'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './http/testing'

/**
 * **The conformance suite against the orchestrator, in process** (PRD-02
 * T3): the whole composition over the memory store and a fake clock, driven
 * through the published client over the app's own `fetch`, webhooks
 * verified by the published verifier before the runner hears them. This is
 * the tier that runs in plain `pnpm verify`; `conformance.extended.test.ts`
 * runs the same flows over a real socket, Postgres and Redis.
 *
 * What this target cannot offer, the runner skips with a reason: the
 * widget's tap (T24), a demo landing anywhere (T21). The fault knobs are the
 * sim provider's (`setFaults`, T14): a crash after a round, with or without
 * the backups to come back from.
 */

const SECRET_ID = 'whsec-conformance'
const SECRET = 'orchestrator-conformance-webhook-secret-not-a-real-one-0123456789'

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function target(): Promise<ConformanceTarget & { app: TestApp }> {
  const app = createTestApp({ sim: { positionTickIntervalMs: 20_000 } })
  const handlers = new Set<(envelope: WebhookEnvelope) => void>()
  const unverified: string[] = []
  app.respond = () => 200
  const budget = { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 }
  const webhookSecrets = [{ id: SECRET_ID, secret: SECRET }]
  const platform: ApiKeyCreated = await app.keys.mint({
    name: 'conformance',
    scopes: ['matches'],
    budget,
    webhookSecrets,
  })
  const thrifty = await app.keys.mint({
    name: 'conformance-thrifty',
    scopes: ['matches'],
    budget: { ...budget, maxServerLifetimeMinutes: 60 },
    webhookSecrets,
  })
  // The endpoint: a consumer that verifies, then acts. Verification hashes
  // on Web Crypto, whose promise settles on a macrotask; the worker's own
  // attempt timeout is on the fake clock, so the two never race here.
  const originalFetch = app.fetch
  const endpoint = async (envelope: WebhookEnvelope, ok: boolean, reason?: string) => {
    if (!ok) unverified.push(`${envelope.payload.type}: ${reason}`)
    else for (const handler of handlers) handler(envelope)
  }
  app.hub.size() // the hub is up
  const clientOptions = {
    baseUrl: 'http://orchestrator.invalid',
    fetch: originalFetch,
    clock: app.clock,
    retry: false as const,
  }
  const client = createMatchApiClient({ ...clientOptions, apiKey: platform.secret })
  const budgetClient = createMatchApiClient({ ...clientOptions, apiKey: thrifty.secret })
  const close = async (): Promise<void> => {
    await app.close()
  }
  closers.push(close)

  // Every accepted POST is verified after the fact from what the endpoint
  // recorded — `received` holds the envelopes the endpoint answered 200 to.
  let verified = 0
  const drainReceived = async (): Promise<void> => {
    while (verified < app.posted.length) {
      const request = app.posted[verified] as (typeof app.posted)[number]
      verified += 1
      const result = await verifyWebhook({
        headers: request.headers,
        body: request.body,
        secrets: { [SECRET_ID]: SECRET },
        clock: app.clock,
      })
      if (result.ok) await endpoint(result.envelope, true)
      else await endpoint(JSON.parse(request.body) as WebhookEnvelope, false, result.reason)
    }
  }

  return {
    app,
    client,
    webhooks: handler => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    callbacks: { webhookUrl: 'https://platform.invalid/hooks/ezpug', webhookSecretId: SECRET_ID },
    clock: app.clock,
    faults: faults => app.sim.setFaults(faults.crash === undefined ? {} : { crash: faults.crash }),
    advance: async ms => {
      await app.advance(ms)
      await drainReceived()
    },
    settle: async () => {
      await app.playOut()
      await drainReceived()
    },
    stream: (subscription, onFrame) => {
      if (subscription.token !== undefined) throw new Error('player tokens arrive with T24')
      const unsubscribe = app.hub.subscribe(subscription.matchId, {
        send: onFrame,
        close: () => undefined,
      })
      void app.store.findMatch(subscription.matchId).then(row => {
        if (row) onFrame({ type: 'hello', matchId: row.id, seq: row.seq, state: row.state })
      })
      return unsubscribe
    },
    budget: { client: budgetClient, maxServerLifetimeMinutes: 60 },
    close,
  }
}

describeMatchApiConformance('the orchestrator over memory', { target })

describe('the suite against the orchestrator', () => {
  it('passes every flow it can run and skips only what a later task builds', async () => {
    const report = await runMatchApiConformance({ target })
    expect(formatConformanceReport(report)).toContain('0 failed')
    expect(report.ok).toBe(true)
    expect(report.results.filter(r => r.status === 'skipped').map(r => r.flow)).toEqual([
      'player-command',
    ])
    expect(report.passed + report.skipped).toBe(MATCH_API_CONFORMANCE_FLOWS.length)
  })
})
