/// <reference types="node" />
import type { FakeClock } from '@ezpug/core'
import { eventually } from '@ezpug/core/testing'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  createHarness,
  type FakeListener,
  type Harness,
  pugRequest,
  WEBHOOK_SECRET,
  WEBHOOK_SECRET_ID,
} from '../fake/testing'
import type { StreamFrame, WebhookEnvelope } from '../index'
import { STREAM_CLOSE_CODES } from '../index'
import {
  createDeliveryDeduper,
  createMemoryDeliveryStore,
  verifyWebhook,
  WEBHOOK_SIGNATURE_TOLERANCE_MS,
} from '../webhooks'
import { createMatchApiClient, type MatchApiClient } from './index'
import type { RetryInfo } from './retry'

/**
 * **The published client and the published verifier against the fake, over a
 * real socket.** Everything here is what a consumer writes: `createMatchApiClient`
 * for the calls, `verifyWebhook` for the deliveries, `createDeliveryDeduper`
 * across the webhook and the replay, `subscribeStream` for the live page. The
 * fake is the orchestrator; the same file will run against the real one in
 * PRD-02 through the conformance suite.
 *
 * Everything is on the harness's fake clock — the fake's deadlines and the
 * client's retry waits both — so a whole Bo1, its webhooks and a 429 storm
 * take milliseconds and no `Date.now()` is read anywhere.
 */

const SECRETS = { [WEBHOOK_SECRET_ID]: WEBHOOK_SECRET }

let harness: Harness | undefined
let listener: FakeListener | undefined

afterEach(async () => {
  await listener?.close()
  listener = undefined
  harness?.fake.close()
  harness = undefined
})

/** The harness on a real port, with the clock time of every webhook POST recorded. */
async function setup(): Promise<{ h: Harness; url: string; receivedAt: number[] }> {
  const h = createHarness()
  harness = h
  const receivedAt: number[] = []
  h.respond = () => {
    receivedAt.push(h.clock.now())
    return 200
  }
  listener = await h.fake.listen()
  return { h, url: listener.url, receivedAt }
}

/** Run a call that may sleep on the fake clock, firing its waits until it settles. */
async function drive<T>(clock: FakeClock, call: Promise<T>): Promise<T> {
  let settled = false
  const tracked = call.then(
    value => {
      settled = true
      return value
    },
    error => {
      settled = true
      throw error
    },
  )
  tracked.catch(() => {})
  await eventually(async () => {
    await clock.runAll()
    expect(settled).toBe(true)
  })
  return tracked
}

async function replay(client: MatchApiClient, matchId: string): Promise<WebhookEnvelope[]> {
  const out: WebhookEnvelope[] = []
  let cursor = '0'
  for (;;) {
    const page = await client.matches.events({ params: { matchId }, query: { cursor, limit: 200 } })
    out.push(...page.items)
    if (page.nextCursor === null || page.items.length === 0) return out
    cursor = page.nextCursor
  }
}

describe('the client and the verifier against the fake over HTTP', () => {
  it('plays create → ready → live → ended, verifies every webhook and replays them from the cursor', async () => {
    const { h, url, receivedAt } = await setup()
    const client = createMatchApiClient({ baseUrl: url, apiKey: h.platform.secret, clock: h.clock })

    const created = await client.matches.create({ body: pugRequest() })
    expect(created.state).toBe('allocating')
    // The idempotency key is the client's, so the same request is the same match.
    const again = await client.matches.create({ body: pugRequest() })
    expect(again.id).toBe(created.id)

    const frames: StreamFrame[] = []
    const socket = client.subscribeStream({
      matchId: created.id,
      onFrame: frame => frames.push(frame),
      onError: error => h.errors.push(error),
      WebSocket,
    })
    await eventually(() => expect(frames).toHaveLength(1))
    expect(frames[0]).toEqual({
      type: 'hello',
      matchId: created.id,
      seq: 0,
      state: 'allocating',
    })

    await h.fake.playOut()

    const match = await client.matches.get({ params: { matchId: created.id } })
    expect(match.state).toBe('ended')
    expect(match.endedReason).toEqual({ kind: 'completed' })

    // Every delivery, verified as the consumer's clock stood when it arrived.
    const deduper = createDeliveryDeduper(createMemoryDeliveryStore())
    const handled: WebhookEnvelope[] = []
    expect(h.posted.length).toBeGreaterThan(0)
    for (const [index, request] of h.posted.entries()) {
      const at = receivedAt[index] as number
      const result = await verifyWebhook({
        headers: request.headers,
        body: request.body,
        secrets: SECRETS,
        clock: { now: () => at },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.attempt).toBe(request.attempt)
      if ((await deduper.check(result.envelope)) === null) handled.push(result.envelope)
    }

    // The events route replays the same story, and the deduper knows it already.
    const replayed = await replay(client, created.id)
    expect(handled.map(envelope => envelope.seq)).toEqual(replayed.map(envelope => envelope.seq))
    expect(handled.map(envelope => envelope.payload.type)).toEqual(
      replayed.map(envelope => envelope.payload.type),
    )
    for (const envelope of replayed)
      expect(await deduper.check(envelope)).toBe('duplicate_delivery')
    expect(replayed.at(-1)?.payload.type).toBe('match.ended')
    expect(match.seq).toBe(replayed.at(-1)?.seq)

    // A signature is only good inside its window: the same delivery, read six
    // minutes late, is refused — and a consumer answers 401 without parsing.
    const first = h.posted[0] as (typeof h.posted)[number]
    const stale = await verifyWebhook({
      headers: first.headers,
      body: first.body,
      secrets: SECRETS,
      clock: { now: () => (receivedAt[0] as number) + WEBHOOK_SIGNATURE_TOLERANCE_MS + 60_000 },
    })
    expect(stale).toMatchObject({ ok: false, reason: 'stale_timestamp', status: 401 })

    // The socket mirrored the same envelopes and closed when the match ended.
    expect(await socket.closed).toEqual({ code: STREAM_CLOSE_CODES.matchEnded, reason: '' })
    const streamed = frames.filter(frame => frame.type === 'event').map(frame => frame.envelope.seq)
    expect(streamed).toEqual(replayed.map(envelope => envelope.seq))
    expect(frames.some(frame => frame.type === 'tick')).toBe(true)
    expect(h.errors).toEqual([])
  })

  it('rides out a 429 storm on the clock and gives up on a refusal that is not weather', async () => {
    const { h, url } = await setup()
    const retries: RetryInfo[] = []
    let storm = 3
    const client = createMatchApiClient({
      baseUrl: url,
      apiKey: h.platform.secret,
      clock: h.clock,
      retry: { onRetry: info => retries.push(info) },
      fetch: (input, init) => {
        if (storm > 0) {
          storm -= 1
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }),
              {
                status: 429,
                headers: { 'content-type': 'application/json', 'retry-after': '1' },
              },
            ),
          )
        }
        return globalThis.fetch(input, init)
      },
    })

    const before = h.clock.now()
    const catalog = await drive(h.clock, client.gamemodes.list())
    expect(catalog.gamemodes).toHaveLength(4)
    expect(retries.map(info => info.status)).toEqual([429, 429, 429])
    expect(retries.map(info => info.delayMs)).toEqual([1_000, 1_000, 1_000])
    expect(h.clock.now()).toBe(before + 3_000)

    // A key without the scope is a verdict: one attempt, one typed error.
    const limited = createMatchApiClient({
      baseUrl: url,
      apiKey: 'fake-key-not-a-key',
      clock: h.clock,
    })
    await expect(drive(h.clock, limited.gamemodes.list())).rejects.toMatchObject({
      name: 'ApiError',
      code: 'unauthorized',
      status: 401,
    })
  })
})
