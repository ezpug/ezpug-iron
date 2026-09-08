import type { ApiKeyCreated, WebhookEnvelope, WidgetServerFrame } from '@ezpug/match-api'
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
import { hashToken } from './tokens'
import { tapThroughWidget } from './widget/testing'

/**
 * **The conformance suite against the orchestrator, in process** (PRD-02
 * T3): the whole composition over the memory store and a fake clock, driven
 * through the published client over the app's own `fetch`, webhooks
 * verified by the published verifier before the runner hears them. This is
 * the tier that runs in plain `pnpm verify`; `conformance.extended.test.ts`
 * runs the same flows over a real socket, Postgres and Redis.
 *
 * Every capability is offered: the widget's tap (T24) goes through the
 * widget service in-process, the way the socket would drive it. The demo
 * lands in the test's own bucket (`app.uploads`), which is a client's
 * storage and not a door of ours. The fault knobs are the sim provider's
 * (`setFaults`, T14): a crash after a round, with or without the backups to
 * come back from.
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
    callbacks: {
      webhookUrl: 'https://platform.invalid/hooks/ezpug',
      webhookSecretId: SECRET_ID,
      // The client's bucket: `app.uploads` is what a simulated server PUT
      // there, and the demo checks are on (T21).
      demoUploadUrl: 'https://bucket.invalid/demos/conformance.dem?signed=1',
    },
    // A series draws one per map (T38a); the same fake bucket, one key each.
    demoUploadUrls: (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        mapNumber: index + 1,
        url: `https://bucket.invalid/demos/conformance/map-${index + 1}.dem?signed=${index + 1}`,
      })),
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
      const unsubscribe = app.hub.subscribe(subscription.matchId, {
        send: onFrame,
        close: () => undefined,
      })
      // A player token authorises the stream too; in-process the check is
      // the widget service's, so a bad token is a thrown refusal here.
      void (async () => {
        if (subscription.token !== undefined) {
          const record = await app.store.findPlayerTokenByHash(hashToken(subscription.token))
          if (!record || record.matchId !== subscription.matchId) {
            unsubscribe()
            throw new Error('the player token does not open this match')
          }
        }
        const row = await app.store.findMatch(subscription.matchId)
        if (row) onFrame({ type: 'hello', matchId: row.id, seq: row.seq, state: row.state })
      })()
      return unsubscribe
    },
    // A widget's tap, through the widget service in-process: open a session
    // with the token, send one command, wait for its result and — when it
    // was applied — for the `plugin_event` the tap left in the log.
    playerCommand: command => tapThroughWidget(app.widgets, command),
    budget: { client: budgetClient, maxServerLifetimeMinutes: 60 },
    close,
  }
}

describeMatchApiConformance('the orchestrator over memory', { target })

describe('the widget door of the orchestrator over memory', () => {
  it('opens a session with the token and answers a tap through the simulated server', async () => {
    const t = await target()
    const request = t.client
    const created = await request.matches.create({
      body: {
        clientMatchId: 'widget-door',
        game: 'cs2',
        gamemode: 'powerup-dm',
        teams: { teamA: { name: 'Alle', players: [] }, teamB: { name: 'Niemand', players: [] } },
        maps: [{ map: 'de_mirage', sides: 'ct' }],
        callbacks: t.callbacks,
        ttlMinutes: 60,
      },
    })
    await t.app.advance(60_000)
    expect((await request.matches.get({ params: { matchId: created.id } })).state).toBe('live')
    const minted = await request.matches.mintPlayerToken({
      params: { matchId: created.id },
      body: { steamId64: '76561198000009999' },
    })
    const frames: WidgetServerFrame[] = []
    const opened = await t.app.widgets.open(
      { token: minted.token },
      { send: frame => frames.push(frame), close: () => undefined },
    )
    if (!opened.ok) throw new Error(`refused ${opened.code}: ${opened.reason}`)
    expect(frames[0]).toMatchObject({
      type: 'hello',
      matchId: created.id,
      steamId64: '76561198000009999',
      gamemode: 'powerup-dm',
      state: 'live',
      commands: [{ name: 'powerup', chargesLeft: 1, readyInMs: 0 }],
    })
    await opened.session.command({ type: 'command', correlationId: 'tap-1', command: 'powerup' })
    await t.app.settle()
    const result = frames.find(f => f.type === 'command_result')
    expect(result).toEqual({
      type: 'command_result',
      correlationId: 'tap-1',
      command: 'powerup',
      status: 'applied',
      chargesLeft: 0,
    })
    expect(
      frames.some(
        f =>
          f.type === 'event' &&
          f.envelope.payload.type === 'plugin_event' &&
          f.envelope.payload.name === 'player_command',
      ),
    ).toBe(true)
    await opened.session.command({ type: 'command', correlationId: 'tap-2', command: 'powerup' })
    expect(frames.filter(f => f.type === 'command_result').at(-1)).toMatchObject({
      correlationId: 'tap-2',
      status: 'rejected',
      code: 'no_charges',
      message: 'Keine Ladung mehr übrig.',
    })
    opened.session.close()
    expect(t.app.widgets.size()).toBe(0)
  })
})

describe('the suite against the orchestrator', () => {
  it('passes every flow and skips none — the widget’s tap included since T24', async () => {
    const report = await runMatchApiConformance({ target })
    expect(formatConformanceReport(report)).toContain('0 failed')
    expect(report.ok).toBe(true)
    expect(report.results.filter(r => r.status === 'skipped').map(r => r.flow)).toEqual([])
    expect(report.passed).toBe(MATCH_API_CONFORMANCE_FLOWS.length)
  })
})
