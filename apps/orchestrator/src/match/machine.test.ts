import {
  ApiError,
  type MatchRequest,
  type MatchRequestInput,
  matchRequestSchema,
  STREAM_CLOSE_CODES,
  type StreamFrame,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
} from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from '../http/testing'
import type { AuthenticatedKey } from '../keys/service'
import { createMatches } from './machine'

/**
 * **The machine, the walk, the deadlines, the reaper, the webhooks and the
 * stream on a fake clock** (PRD-02 T3) — every path the conformance suite
 * cannot reach from outside: a server that dies with no backup, a boot that
 * never ends, a provider that refuses every allocation, a ttl that runs
 * out, a process that restarts mid-match, a webhook endpoint that fails
 * and one that says `410`, an orphan the reaper finds.
 */

const SECRET_ID = 'whsec-1'
const SECRET = 'a-test-secret-of-at-least-thirty-two-chars'

async function platformKey(app: TestApp, name = 'platform') {
  const minted = await app.keys.mint({
    name,
    scopes: ['matches', 'fleet'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: SECRET_ID, secret: SECRET }],
  })
  return { secret: minted.secret, key: (await app.keys.get(minted.key.id)) as AuthenticatedKey }
}

const TEAM_A = ['hunzR', 'maex', 'Zerberus', 'flippo', 'Kessi']
const TEAM_B = ['wickeD', 'Jörg', 'schnitzL', 'BastiGHG', 'moepL']
const roster = (names: string[], offset: number) =>
  names.map((name, i) => ({
    steamId64: `7656119800000${String(offset + i).padStart(4, '0')}`,
    name,
  }))

function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  return matchRequestSchema.parse({
    clientMatchId: 'platform-match-1',
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Team hunzR', players: roster(TEAM_A, 0) },
      teamB: { name: 'Team wickeD', players: roster(TEAM_B, 100) },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    rules: {
      regulationRounds: 2,
      overtime: { enabled: false, maxRounds: 2, startMoney: 10_000 },
      warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
    },
    callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: SECRET_ID },
    ttlMinutes: 120,
    ...overrides,
  })
}

async function refused(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected an ApiError')
}

const types = (app: TestApp, matchId: string) =>
  app.store.rows.events.filter(e => e.matchId === matchId).map(e => e.payload.type)

describe('the walk', () => {
  it('writes the ledger row before the provider answers and closes it when the match ends', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    expect(match.state).toBe('pending')
    await app.settle()
    const row = app.store.rows.servers[0]
    expect(row).toMatchObject({
      provider: 'sim',
      serverId: 'sim-1',
      matchId: match.id,
      state: 'configured',
    })
    expect(app.store.rows.serverTokens).toHaveLength(1)
    const configuring = await app.matches.get(key, match.id)
    expect(configuring.state).toBe('configuring')
    expect(configuring.connect).toBeNull()
    await app.playOut()
    const ended = await app.matches.get(key, match.id)
    expect(ended.state).toBe('ended')
    expect(ended.endedReason).toEqual({ kind: 'completed' })
    expect(ended.connect?.password).toMatch(/^[A-Za-z0-9_-]{12}$/)
    expect(app.store.rows.servers[0]).toMatchObject({
      state: 'released',
      releasedReason: 'ended: completed',
    })
    expect(app.sim.size()).toBe(0)
    expect(app.links.size()).toBe(0)
    expect(types(app, match.id).at(-1)).toBe('match.ended')
    expect(app.clock.pending()).toBe(0)
    await app.close()
  })

  it('refuses at the door with no provider, and fails allocation_failed when every candidate refuses', async () => {
    const empty = createTestApp({ noProviders: true })
    const { key } = await platformKey(empty)
    const door = await refused(empty.matches.create(key, request()))
    expect(door.code).toBe('no_capable_server')
    expect(empty.store.rows.matches).toHaveLength(0)

    const full = createTestApp({ simCapacity: 1, sim: { positionTickIntervalMs: null } })
    const { key: k } = await platformKey(full)
    const first = await full.matches.create(k, request({ clientMatchId: 'a' }))
    await full.settle()
    // Capacity is spent; the second is refused at the door, not after a row.
    const second = await refused(full.matches.create(k, request({ clientMatchId: 'b' })))
    expect(second.code).toBe('no_capable_server')
    expect(full.store.rows.servers).toHaveLength(1)
    // A provider that says yes to offerings and no to allocate: the walk exhausts and fails.
    full.sim.allocate = () => Promise.reject(new Error('sim: refused'))
    await full.matches.cancel(k, first.match.id)
    const { match: third } = await full.matches.create(k, request({ clientMatchId: 'c' }))
    await full.settle()
    const failed = await full.matches.get(k, third.id)
    expect(failed.state).toBe('failed')
    expect(failed.endedReason?.kind).toBe('allocation_failed')
    expect(full.store.rows.servers.filter(r => r.matchId === third.id)).toEqual([
      expect.objectContaining({
        state: 'failed',
        releasedReason: 'allocate failed',
        serverId: null,
      }),
    ])
    expect(types(full, third.id)).toEqual(['match.failed'])
    await full.close()
    await empty.close()
  })

  it('answers a repeated clientMatchId with the same match and a different body with conflict', async () => {
    const app = createTestApp()
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    const again = await app.matches.create(key, request())
    expect(again).toEqual({ match: expect.objectContaining({ id: match.id }), replayed: true })
    const conflict = await refused(app.matches.create(key, request({ ttlMinutes: 60 })))
    expect(conflict.code).toBe('conflict')
    await app.close()
  })
})

describe('deadlines', () => {
  it('fails provider_error when the server never boots', async () => {
    const app = createTestApp({ sim: { scenario: 'never-ready', positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    await app.advance(5 * 60_000 - 1)
    expect((await app.matches.get(key, match.id)).state).toBe('configuring')
    await app.advance(2)
    const failed = await app.matches.get(key, match.id)
    expect(failed.state).toBe('failed')
    expect(failed.endedReason).toMatchObject({ kind: 'provider_error' })
    expect(app.store.rows.servers[0]?.state).toBe('failed')
    await app.close()
  })

  it('ends ttl_expired when the request’s lifetime runs out, whatever the server says', async () => {
    const app = createTestApp({ sim: { timeScale: 0.25, positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request({ ttlMinutes: 10 }))
    await app.advance(10 * 60_000)
    const ended = await app.matches.get(key, match.id)
    expect(ended.state).toBe('ended')
    expect(ended.endedReason?.kind).toBe('ttl_expired')
    expect(app.sim.size()).toBe(0)
    await app.close()
  })

  it('opens the recovery window on a lost server and fails server_lost with no backup', async () => {
    const app = createTestApp({ sim: { scenario: 'server-crash', positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(
      key,
      request({ rules: { ...request().rules, regulationRounds: 24 } as never }) as never,
    )
    await app.playOut()
    const failed = await app.matches.get(key, match.id)
    expect(failed.state).toBe('failed')
    expect(failed.endedReason).toMatchObject({ kind: 'server_lost' })
    const order = types(app, match.id)
    expect(order.slice(-2)).toEqual(['match.recovering', 'match.failed'])
    const recovering = app.store.rows.events.find(
      e => e.payload.type === 'match.recovering',
    )?.payload
    expect(recovering).toMatchObject({ backupRound: null, reason: expect.stringContaining('gone') })
    expect(app.store.rows.servers[0]).toMatchObject({ state: 'failed' })
    await app.close()
  })

  it('re-arms every deadline from the rows after a restart', async () => {
    const app = createTestApp({ sim: { scenario: 'never-ready', positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    await app.advance(60_000)
    expect((await app.matches.get(key, match.id)).state).toBe('configuring')
    // The process dies: timers gone, the store stays.
    await app.matches.close()
    const revived = createMatches({
      clock: app.clock,
      log: app.log,
      store: app.store,
      providers: app.providers,
      links: app.links,
      gamemodes: (await import('@ezpug/match-api')).SHIPPED_GAMEMODES,
      hub: app.hub,
      webhooks: app.webhooks,
      baseUrl: 'http://localhost:3430',
    })
    await revived.resume()
    // The boot deadline counts from when configuring was entered, not from the restart.
    await app.clock.advance(4 * 60_000 - 1)
    await revived.settle()
    expect((await revived.get(key, match.id)).state).toBe('configuring')
    await app.clock.advance(2)
    await revived.settle()
    expect((await revived.get(key, match.id)).endedReason?.kind).toBe('provider_error')
    await revived.close()
    await app.close()
  })
})

describe('commands and cancel', () => {
  it('replays a correlationId, relays to the server, and refuses what the state forbids', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    const early = await app.matches.command(key, match.id, { type: 'pause', correlationId: 'p0' })
    expect(early).toMatchObject({ status: 'rejected', code: 'invalid_state' })
    // Play until live.
    for (let i = 0; i < 200 && (await app.matches.get(key, match.id)).state !== 'live'; i += 1) {
      await app.clock.next()
      await app.settle()
    }
    expect((await app.matches.get(key, match.id)).state).toBe('live')
    const cancel = await refused(app.matches.cancel(key, match.id))
    expect(cancel.code).toBe('invalid_state')
    const said = await app.matches.command(key, match.id, {
      type: 'announce',
      correlationId: 'a1',
      text: 'glhf',
    })
    expect(said.status).toBe('applied')
    const replay = await app.matches.command(key, match.id, {
      type: 'announce',
      correlationId: 'a1',
      text: 'other',
    })
    expect(replay).toEqual(said)
    expect(app.store.rows.commands).toHaveLength(2)
    const sim = await app.matches.command(key, match.id, { type: 'sim.kill', correlationId: 's1' })
    expect(sim).toMatchObject({ status: 'rejected', code: 'command_unsupported' })
    const rcon = await refused(
      app.matches.command(key, match.id, { type: 'rcon', correlationId: 'r1', command: 'status' }),
    )
    expect(rcon.code).toBe('forbidden')
    const kicked = await app.matches.command(key, match.id, {
      type: 'kick',
      correlationId: 'k1',
      steamId64: '76561198000000000',
    })
    expect(kicked.status).toBe('applied')
    await app.settle()
    expect(types(app, match.id).at(-1)).toBe('player.left')
    const ended = await app.matches.command(key, match.id, {
      type: 'force_end',
      correlationId: 'f1',
    })
    expect(ended.status).toBe('applied')
    expect((await app.matches.get(key, match.id)).endedReason?.kind).toBe('force_ended')
    await app.close()
  })

  it('cancels before live and releases the row', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    await app.settle()
    const cancelled = await app.matches.cancel(key, match.id)
    expect(cancelled.state).toBe('cancelled')
    expect(app.store.rows.servers[0]?.state).toBe('released')
    expect(app.sim.size()).toBe(0)
    expect(types(app, match.id)).toEqual(['match.allocated', 'match.ended'])
    await app.close()
  })
})

describe('the fleet', () => {
  it('lists open rows, releases one by handle, and drains a provider', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    await app.settle()
    expect((await app.fleet.servers()).map(s => s.serverId)).toEqual(['sim-1'])
    const released = await app.fleet.release('sim-1', 'stuck')
    await app.settle()
    expect(released.state).toBe('released')
    expect((await app.matches.get(key, match.id)).endedReason).toMatchObject({
      kind: 'provider_error',
      detail: 'released by operator: stuck',
    })
    expect(await app.fleet.servers()).toEqual([])
    expect((await app.fleet.ledger({}, undefined, 50)).items).toHaveLength(1)
    await app.fleet.setDrained('sim', true)
    expect((await app.fleet.capacity()).providers[0]).toMatchObject({
      drained: true,
      regions: [{ available: 0 }],
    })
    const refusedCreate = await refused(app.matches.create(key, request({ clientMatchId: 'x' })))
    expect(refusedCreate.code).toBe('no_capable_server')
    await app.fleet.setDrained('sim', false)
    expect((await app.fleet.capacity()).providers[0]?.regions[0]?.available).toBe(8)
    await app.close()
  })
})

describe('the reaper', () => {
  it('reaps an orphan after the grace window and surfaces a lost server to the machine', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    await app.settle()
    // An orphan: a server the provider runs for nobody.
    await app.sim.allocate({
      matchId: '00000000-0000-4000-8000-000000000001',
      fleetServerId: '00000000-0000-4000-8000-000000000002',
      keyId: key.key.id,
      requirements: { game: 'cs2' },
      offering: (await app.sim.offerings())[0] as never,
      ttlMinutes: 10,
    })
    expect(app.sim.size()).toBe(2)
    const first = await app.reaper.reconcile()
    expect(first.reaped).toEqual([])
    await app.clock.advance(120_000)
    const second = await app.reaper.reconcile()
    expect(second.reaped).toEqual([expect.objectContaining({ serverId: 'sim-2' })])
    expect(app.sim.size()).toBe(1)
    // A lost server: the ledger holds it, the provider no longer lists it.
    const before = (await app.matches.get(key, match.id)).state
    await app.sim.deallocate('sim-1')
    const third = await app.reaper.reconcile()
    expect(third.lost.map(r => r.serverId)).toEqual(['sim-1'])
    await app.settle()
    const after = await app.matches.get(key, match.id)
    // Lost while live opens the window (no backup: server_lost); lost before that is the provider's fault.
    expect(after.endedReason?.kind).toBe(before === 'live' ? 'server_lost' : 'provider_error')
    expect(types(app, match.id).includes('match.recovering')).toBe(before === 'live')
    await app.close()
  })
})

describe('webhooks', () => {
  it('signs, retries on the published schedule, stops on 410, and gives up after the tenth attempt', async () => {
    // A server that never boots says nothing, so `match.allocated` is the one delivery for five minutes.
    const app = createTestApp({ sim: { scenario: 'never-ready', positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    let failures = 2
    app.respond = () => (failures-- > 0 ? 503 : 200)
    const { match } = await app.matches.create(key, request())
    await app.settle()
    expect(app.attempts.map(a => a.outcome)).toEqual(['retry'])
    await app.advance(WEBHOOK_RETRY_DELAYS_MS[0])
    expect(app.attempts.map(a => a.outcome)).toEqual(['retry', 'retry'])
    await app.advance(WEBHOOK_RETRY_DELAYS_MS[1])
    expect(app.attempts.map(a => a.outcome)).toEqual(['retry', 'retry', 'delivered'])
    expect(app.posted[2]?.headers['x-ezpug-attempt']).toBe('3')
    expect(app.posted[2]?.headers['x-ezpug-signature']).toMatch(
      /^t=\d+,kid=whsec-1,v1=[0-9a-f]{64}$/,
    )
    expect(app.received[0]?.payload.type).toBe('match.allocated')

    await app.matches.cancel(key, match.id)

    const gone = createTestApp({ sim: { positionTickIntervalMs: null } })
    const { key: k410 } = await platformKey(gone)
    gone.respond = () => 410
    const { match: stopped } = await gone.matches.create(k410, request({ clientMatchId: 'gone' }))
    await gone.playOut()
    // One attempt, one `410`, and no later envelope is even queued.
    const rows = gone.store.rows.deliveries.filter(d => d.matchId === stopped.id)
    expect(rows).toEqual([expect.objectContaining({ seq: 1, status: 'stopped', attempt: 1 })])
    expect(gone.attempts).toHaveLength(1)
    expect(gone.store.rows.matches[0]?.webhooksStoppedAt).not.toBeNull()
    // The events route still has every fact.
    const page = await gone.matches.events(k410, stopped.id, 0, 200)
    expect(page.items.length).toBeGreaterThan(5)
    expect(page.items.at(-1)?.payload.type).toBe('match.ended')
    expect(page.nextCursor).toBeNull()
    await gone.close()

    const other = createTestApp({ sim: { scenario: 'never-ready', positionTickIntervalMs: null } })
    const { key: k2 } = await platformKey(other)
    other.respond = () => null
    await other.matches.create(k2, request({ clientMatchId: 'gone' }))
    await other.playOut()
    const first = other.attempts.filter(a => a.seq === 1)
    expect(first).toHaveLength(WEBHOOK_MAX_ATTEMPTS)
    expect(first.at(-1)?.outcome).toBe('given_up')
    await other.close()
    await app.close()
  })
})

describe('the stream', () => {
  it('mirrors events, batches ticks, snapshots presence and closes 4000 at the end', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: 5_000 } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    const frames: StreamFrame[] = []
    let closedWith: number | undefined
    app.hub.subscribe(match.id, {
      send: f => void frames.push(f),
      close: code => {
        closedWith = code
      },
    })
    await app.playOut()
    expect(new Set(frames.map(f => f.type))).toEqual(new Set(['event', 'tick', 'presence']))
    expect(
      frames.filter(f => f.type === 'tick').every(f => f.type === 'tick' && f.ticks.length >= 1),
    ).toBe(true)
    const events = frames.filter(f => f.type === 'event')
    expect(events.at(-1)).toMatchObject({ envelope: { payload: { type: 'match.ended' } } })
    expect(closedWith).toBe(STREAM_CLOSE_CODES.matchEnded)
    expect(app.hub.size()).toBe(0)
    const stored = app.store.rows.events.filter(e => e.matchId === match.id)
    expect(events.length).toBe(stored.length)
    expect(stored.some(e => (e.payload.type as string) === 'position_tick')).toBe(false)
    await app.close()
  })
})
