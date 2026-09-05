import { createFakeClock } from '@ezpug/core'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../errors'
import { IDEMPOTENCY_KEY_HEADER } from '../rpc'
import { createMatchApiClient, idempotencyKeyFor } from './index'

const T0 = Date.parse('2026-09-05T18:00:00.000Z')

interface Sent {
  url: string
  method: string
  headers: Headers
  body: string | null
}

function recorder(answer: (sent: Sent) => Response) {
  const sent: Sent[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const record: Sent = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    }
    sent.push(record)
    return answer(record)
  }) as typeof globalThis.fetch
  return { sent, fetch: fetchImpl }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const matchAnswer = {
  id: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
  clientMatchId: 'platform-match-1',
  state: 'allocating',
  game: 'cs2',
  gamemode: 'pug',
  seq: 0,
  provider: null,
  region: null,
  serverId: null,
  fleetServerId: null,
  connect: null,
  tv: null,
  sim: null,
  endedReason: null,
  readyAt: null,
  liveAt: null,
  endedAt: null,
  createdAt: '2026-09-05T18:00:00.000Z',
  updatedAt: '2026-09-05T18:00:00.000Z',
  expiresAt: '2026-09-05T21:00:00.000Z',
}

describe('createMatchApiClient', () => {
  it('is typed from the route table and sends the key as a bearer', async () => {
    const { sent, fetch } = recorder(() => json(200, { gamemodes: [] }))
    const client = createMatchApiClient({
      baseUrl: 'https://gs.ezpug.example',
      apiKey: 'ezk_fake_platform_key',
      fetch,
    })
    const catalog = await client.gamemodes.list()
    expect(catalog.gamemodes).toEqual([])
    expect(sent[0]?.url).toBe('https://gs.ezpug.example/v1/gamemodes')
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer ezk_fake_platform_key')
  })

  it('leaves the stream upgrade out — a socket is subscribed to, not called', () => {
    const client = createMatchApiClient({ baseUrl: 'https://gs.ezpug.example', apiKey: 'ezk_x' })
    expect('events' in client.matches).toBe(true)
    expect('stream' in client.matches).toBe(false)
    // @ts-expect-error the upgrade route is not a call on the client
    expect(client.matches.stream).toBeUndefined()
    expect(typeof client.subscribeStream).toBe('function')
  })

  it('carries the body’s own idempotency key on the calls that have one', async () => {
    const { sent, fetch } = recorder(record =>
      record.url.endsWith('/commands')
        ? json(200, {
            correlationId: '9f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
            type: 'announce',
            status: 'applied',
          })
        : record.url.endsWith('/player-tokens')
          ? json(201, {
              token: 'fake-player-token-abcdefghijklmnop',
              matchId: matchAnswer.id,
              steamId64: '76561198000000001',
              expiresAt: '2026-09-05T18:15:00.000Z',
            })
          : json(201, matchAnswer),
    )
    const client = createMatchApiClient({
      baseUrl: 'https://gs.ezpug.example',
      apiKey: 'ezk_fake_platform_key',
      fetch,
    })

    await client.matches.create({
      body: {
        clientMatchId: 'platform-match-1',
        game: 'cs2',
        gamemode: 'pug',
        teams: {
          teamA: { name: 'A', players: [{ steamId64: '76561198000000001', name: 'hunzR' }] },
          teamB: { name: 'B', players: [{ steamId64: '76561198000000002', name: 'wickeD' }] },
        },
        maps: [{ map: 'de_mirage', sides: 'ct' }],
        callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: 'whsec-x' },
        ttlMinutes: 180,
      },
    })
    expect(sent[0]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe('matches.create:platform-match-1')

    await client.matches.command({
      params: { matchId: matchAnswer.id },
      body: {
        type: 'announce',
        correlationId: '9f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
        text: 'glhf',
      },
    })
    expect(sent[1]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(
      'matches.command:9f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
    )

    // A mint makes a new secret every time; repeating one is the caller's call.
    await client.matches.mintPlayerToken({
      params: { matchId: matchAnswer.id },
      body: { steamId64: '76561198000000001' },
    })
    expect(sent[2]?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBeNull()

    // And a GET never carries one.
    expect(
      idempotencyKeyFor({
        key: 'matches.get',
        route: {} as never,
        input: {} as never,
        url: new URL('https://gs.ezpug.example/v1/matches/x'),
      }),
    ).toBeUndefined()
  })

  it('retries a create through a 502 and throws the typed error the envelope names', async () => {
    const clock = createFakeClock({ start: T0 })
    let attempts = 0
    const { fetch } = recorder(() => {
      attempts += 1
      return attempts === 1
        ? new Response('<html>bad gateway</html>', { status: 502 })
        : json(402, {
            error: {
              code: 'budget_exceeded',
              message: 'the key is at its monthly ceiling',
              details: { limit: 'monthlyCents' },
            },
          })
    })
    const client = createMatchApiClient({
      baseUrl: 'https://gs.ezpug.example',
      apiKey: 'ezk_fake_platform_key',
      fetch,
      clock,
      retry: { delaysMs: [10] },
    })

    const call = client.matches.create({
      body: {
        clientMatchId: 'platform-match-2',
        game: 'cs2',
        gamemode: 'pug',
        teams: {
          teamA: { name: 'A', players: [{ steamId64: '76561198000000001', name: 'hunzR' }] },
          teamB: { name: 'B', players: [{ steamId64: '76561198000000002', name: 'wickeD' }] },
        },
        maps: [{ map: 'de_mirage', sides: 'ct' }],
        callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: 'whsec-x' },
        ttlMinutes: 180,
      },
    })
    const caught = call.then(
      () => null,
      (error: unknown) => error,
    )
    for (let round = 0; round < 20; round += 1) {
      await clock.runAll()
      await Promise.resolve()
    }
    const error = await caught
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('budget_exceeded')
    expect((error as ApiError).status).toBe(402)
    expect((error as ApiError).details).toEqual({ limit: 'monthlyCents' })
    // The 502 was repeated (the create carries a key), the 402 was not.
    expect(attempts).toBe(2)
  })
})
