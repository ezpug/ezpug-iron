import {
  ApiError,
  type GameserverEvent,
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
import type { GameServerProvider, ServerConfiguration } from '../providers/provider'
import { createMatches } from './machine'

/** A LAN-shaped provider whose servers do nothing but exist, so a test speaks for them. */
const PHANTOM = 'nodes'
function createPhantomProvider(): GameServerProvider {
  let counter = 0
  const live = new Map<string, { matchId: string; fleetServerId: string }>()
  const configured = new Map<string, ServerConfiguration>()
  return {
    id: PHANTOM,
    offerings: () =>
      Promise.resolve([
        {
          capabilities: {
            games: ['cs2'],
            region: 'devbox',
            tickrate: 128,
            lan: true,
            workshopMaps: true,
          },
          hourlyCents: 0,
          available: 4,
        },
      ]),
    allocate: allocation => {
      counter += 1
      const serverId = `devbox-${counter}`
      live.set(serverId, { matchId: allocation.matchId, fleetServerId: allocation.fleetServerId })
      return Promise.resolve({ serverId, connect: { host: '127.0.0.1', port: 27_415 } })
    },
    configure: (serverId, configuration) => {
      configured.set(serverId, configuration)
      return Promise.resolve()
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    status: serverId =>
      Promise.resolve(
        live.has(serverId)
          ? { state: 'running', connect: { host: '127.0.0.1', port: 27_415 } }
          : { state: 'gone' },
      ),
    deallocate: serverId => {
      live.delete(serverId)
      return Promise.resolve()
    },
    list: () => Promise.resolve([...live].map(([serverId, entry]) => ({ serverId, ...entry }))),
  }
}

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
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    // The box takes its backups with it: nothing to come back from.
    app.sim.setFaults({ crash: { afterRound: 9, backup: false } })
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
      budget: app.budgets,
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
    // Lost while live opens the window and the replacement walk; lost before that is the provider's fault.
    expect(types(app, match.id).includes('match.recovering')).toBe(before === 'live')
    if (before === 'live') {
      expect(after.state).toBe('recovering')
      expect(after.serverId).toBe('sim-3')
    } else {
      expect(after.endedReason?.kind).toBe('provider_error')
    }
    await app.close()
  })
})

describe('recovery', () => {
  const crash = (afterRound: number, backup: boolean) => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    app.sim.setFaults({ crash: { afterRound, backup } })
    return app
  }
  const rules = { ...request().rules, regulationRounds: 4 } as never

  it('brings a lost match back on a replacement from its newest backup, and the match finishes there', async () => {
    const app = crash(2, true)
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request({ rules }))
    await app.playOut()

    const final = await app.matches.get(key, match.id)
    expect(final.state).toBe('ended')
    expect(final.endedReason).toEqual({ kind: 'completed' })
    expect(final.serverId).toBe('sim-2')
    const order = types(app, match.id)
    expect(order.filter(t => t === 'match.allocated')).toHaveLength(2)
    expect(order.indexOf('match.recovering')).toBeLessThan(order.lastIndexOf('match.allocated'))
    expect(order.lastIndexOf('match.server_ready')).toBeLessThan(order.indexOf('match.recovered'))
    expect(order.at(-1)).toBe('match.ended')

    const facts = app.store.rows.events.filter(e => e.matchId === match.id).map(e => e.payload)
    const recovering = facts.find(f => f.type === 'match.recovering')
    expect(recovering).toMatchObject({ backupRound: 2, reason: expect.stringContaining('gone') })
    // The replacement's connect facts are said again, marked as a return.
    const readies = facts.filter(f => f.type === 'match.server_ready')
    expect(readies).toHaveLength(2)
    expect(readies[0]).not.toHaveProperty('restored')
    expect(readies[1]).toMatchObject({
      restored: true,
      round: 2,
      connect: expect.objectContaining({ host: 'sim-2.sim.invalid' }),
    })
    expect(facts.find(f => f.type === 'match.recovered')).toMatchObject({
      serverId: 'sim-2',
      resumedFromRound: 2,
    })
    // The rounds after the crash were played by the replacement, from the backup's round on.
    const rounds = facts.filter(f => f.type === 'round_end') as {
      source: { serverId: string }
      roundNumber: number
    }[]
    expect(rounds.map(r => `${r.source.serverId}#${r.roundNumber}`)).toEqual([
      'sim-1#1',
      'sim-1#2',
      'sim-2#2',
      'sim-2#3',
      'sim-2#4',
    ])

    // The ledger: the corpse failed and deallocated, the replacement released at the end.
    const rows = app.store.rows.servers.filter(r => r.matchId === match.id)
    expect(rows.map(r => [r.serverId, r.state])).toEqual([
      ['sim-1', 'failed'],
      ['sim-2', 'released'],
    ])
    expect(rows.every(r => r.releasedAt !== null)).toBe(true)
    expect(app.sim.size()).toBe(0)
    expect(app.links.size()).toBe(0)
    await app.close()
  })

  it('fails server_lost when the replacement stands ready and nobody comes back', async () => {
    const app = crash(2, true)
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request({ rules }))
    await app.settle()
    while ((await app.matches.get(key, match.id)).state !== 'recovering') {
      await app.clock.next()
      await app.settle()
    }
    // The replacement boots and says ready; then its story is parked before anyone goes live.
    while (
      !types(app, match.id).some(
        (t, i, all) => t === 'match.server_ready' && i > all.indexOf('match.recovering'),
      )
    ) {
      await app.clock.next()
      await app.settle()
    }
    // Parked in step mode: up (the probe finds it running), heartbeating nothing, going live never.
    const replacement = (await app.matches.get(key, match.id)).serverId as string
    app.sim.engine(replacement)?.setMode('step')
    expect((await app.matches.get(key, match.id)).state).toBe('recovering')
    await app.advance(20 * 60_000 + 1)
    const final = await app.matches.get(key, match.id)
    expect(final.state).toBe('failed')
    expect(final.endedReason).toMatchObject({
      kind: 'server_lost',
      detail: expect.stringContaining('no going_live'),
    })
    expect(types(app, match.id)).not.toContain('match.recovered')
    expect(app.sim.size()).toBe(0)
    await app.close()
  })

  it('refuses a restore while one is in progress, and takes one after a restart left the window open', async () => {
    const app = crash(2, true)
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request({ rules }))
    await app.settle()
    while ((await app.matches.get(key, match.id)).state !== 'recovering') {
      await app.clock.next()
      await app.settle()
    }
    const busy = await app.matches.command(key, match.id, { type: 'restore', correlationId: 'r1' })
    expect(busy).toMatchObject({ status: 'rejected', code: 'invalid_state' })
    const none = await app.matches.command(key, match.id, {
      type: 'restore',
      correlationId: 'r2',
      roundNumber: 9,
    })
    expect(none).toMatchObject({ status: 'rejected', code: 'no_backup' })

    // The process dies with the window open and the replacement gone with it.
    await app.matches.close()
    const replacement = (await app.matches.get(key, match.id)).serverId as string
    await app.sim.deallocate(replacement)
    await app.store.updateServer(
      app.store.rows.servers.find(r => r.serverId === replacement)?.id as string,
      { state: 'failed', releasedAt: app.clock.date(), releasedReason: 'died with the process' },
    )
    const revived = createMatches({
      clock: app.clock,
      log: app.log,
      store: app.store,
      providers: app.providers,
      links: app.links,
      gamemodes: (await import('@ezpug/match-api')).SHIPPED_GAMEMODES,
      hub: app.hub,
      webhooks: app.webhooks,
      budget: app.budgets,
      baseUrl: 'http://localhost:3430',
    })
    app.sink.current = revived
    // No resume: the door for exactly this gap.
    const taken = await revived.command(key, match.id, {
      type: 'restore',
      correlationId: 'r3',
      roundNumber: 1,
    })
    expect(taken).toMatchObject({ status: 'applied' })
    for (let i = 0; i < 2_000 && (await revived.get(key, match.id)).state !== 'ended'; i += 1) {
      await revived.settle()
      await app.sim.settle()
      await app.clock.next()
    }
    await revived.settle()
    const final = await revived.get(key, match.id)
    expect(final.state).toBe('ended')
    expect(final.serverId).toBe('sim-3')
    const recovered = app.store.rows.events.find(
      e => e.matchId === match.id && e.payload.type === 'match.recovered',
    )?.payload
    expect(recovered).toMatchObject({ serverId: 'sim-3', resumedFromRound: 1 })
    await revived.close()
    await app.close()
  })

  it('resumes the walk after a restart with the window open, and waits for players when the replacement is up', async () => {
    const app = crash(2, true)
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request({ rules }))
    await app.settle()
    while ((await app.matches.get(key, match.id)).state !== 'recovering') {
      await app.clock.next()
      await app.settle()
    }
    await app.matches.close()
    const replacement = (await app.matches.get(key, match.id)).serverId as string
    await app.sim.deallocate(replacement)
    await app.store.updateServer(
      app.store.rows.servers.find(r => r.serverId === replacement)?.id as string,
      { state: 'failed', releasedAt: app.clock.date(), releasedReason: 'died with the process' },
    )
    const revived = createMatches({
      clock: app.clock,
      log: app.log,
      store: app.store,
      providers: app.providers,
      links: app.links,
      gamemodes: (await import('@ezpug/match-api')).SHIPPED_GAMEMODES,
      hub: app.hub,
      webhooks: app.webhooks,
      budget: app.budgets,
      baseUrl: 'http://localhost:3430',
    })
    app.sink.current = revived
    await revived.resume()
    await revived.settle()
    expect((await revived.get(key, match.id)).serverId).toBe('sim-3')
    for (let i = 0; i < 2_000 && (await revived.get(key, match.id)).state !== 'ended'; i += 1) {
      await revived.settle()
      await app.sim.settle()
      await app.clock.next()
    }
    await revived.settle()
    expect((await revived.get(key, match.id)).state).toBe('ended')
    expect(types(app, match.id).filter(t => t === 'match.allocated')).toHaveLength(3)
    await revived.close()
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

/**
 * **Demos** (PRD-02 T21). The server owns the upload and the orchestrator owns
 * the fact: a `demo_available` that carries a hash is relayed as
 * `demo.uploaded`, and every `match.ended` says what became of the demos —
 * including the honest answers when there was never going to be one.
 */
describe('the demo', () => {
  const withDemo = (overrides: Partial<MatchRequestInput> = {}) =>
    request({
      callbacks: {
        webhookUrl: 'https://platform.invalid/hooks',
        webhookSecretId: SECRET_ID,
        demoUploadUrl: 'https://bucket.invalid/demos/one.dem?signed=1',
      },
      ...overrides,
    })

  it('is PUT by the server, relayed as a fact, and counted in the ended fact', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, withDemo())
    await app.playOut()

    // The simulated server did the upload, exactly as a plugin does.
    expect(app.uploads).toHaveLength(1)
    expect(app.uploads[0]?.url).toBe('https://bucket.invalid/demos/one.dem?signed=1')
    expect(app.uploads[0]?.contentType).toContain('application/json')
    expect(app.uploads[0]?.bytes).toBeGreaterThan(0)

    const order = types(app, match.id)
    expect(order.indexOf('demo_available')).toBeGreaterThan(-1)
    expect(order.indexOf('demo_available')).toBeLessThan(order.indexOf('demo.uploaded'))
    const uploaded = app.store.rows.events.find(
      e => e.matchId === match.id && e.payload.type === 'demo.uploaded',
    )?.payload
    expect(uploaded).toMatchObject({
      mapNumber: 1,
      key: 'demos/one.dem',
      contentType: 'application/json; charset=utf-8',
    })
    expect((uploaded as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((uploaded as { size: number }).size).toBe(app.uploads[0]?.bytes)
    expect(
      app.store.rows.events.find(e => e.matchId === match.id && e.payload.type === 'match.ended')
        ?.payload,
    ).toMatchObject({ demo: { uploaded: 1 } })
    await app.close()
  })

  it('is not asked for when the request named nowhere to put one', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    await app.playOut()

    expect(app.uploads).toEqual([])
    expect(types(app, match.id)).not.toContain('demo.uploaded')
    expect(
      app.store.rows.events.find(e => e.matchId === match.id && e.payload.type === 'match.ended')
        ?.payload,
    ).toMatchObject({ demo: { uploaded: 0, skipped: 'no_upload_url' } })
    await app.close()
  })

  it('is never expected of a mode that records events only', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(
      key,
      withDemo({ gamemode: 'flying-scoutsman', rules: undefined }),
    )
    await app.playOut()

    expect(app.uploads).toEqual([])
    expect(
      app.store.rows.events.find(e => e.matchId === match.id && e.payload.type === 'match.ended')
        ?.payload,
    ).toMatchObject({ demo: { uploaded: 0, skipped: 'not_recorded' } })
    await app.close()
  })

  it('leaves the match ended honestly when the storage refuses it', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    app.storeDemo = () => 403
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, withDemo())
    await app.playOut()

    // The bytes stayed on the server: the demo was announced, nothing landed.
    expect(app.uploads).toHaveLength(1)
    expect(types(app, match.id)).toContain('demo_available')
    expect(types(app, match.id)).not.toContain('demo.uploaded')
    expect(
      app.store.rows.events.find(e => e.matchId === match.id && e.payload.type === 'match.ended')
        ?.payload,
    ).toMatchObject({ demo: { uploaded: 0, skipped: 'upload_failed' } })
    await app.close()
  })

  /**
   * **The window a real GOTV demo needs.** GOTV records the *delayed*
   * broadcast, so MatchZy stops recording `tv_delay` after the last round and
   * the plugin uploads what settles — all of it well after the `series_end`
   * the orchestrator would otherwise end the match on, and ending it releases
   * the server the file is still sitting on.
   */
  const scripted = async (app: TestApp, body = withDemo()) => {
    const { key } = await platformKey(app)
    const { match } = await app.matches.create(key, body)
    await app.settle()
    const row = app.store.rows.servers.find(server => server.matchId === match.id)
    if (!row?.serverId) throw new Error('the walk left no server')
    const source = { provider: PHANTOM, serverId: row.serverId }
    const say = async (event: Record<string, unknown> & { type: GameserverEvent['type'] }) =>
      app.matches.ingest(source, { ...event, matchId: match.id, source } as GameserverEvent)
    await say({ type: 'server_ready', map: 'de_mirage' })
    await say({ type: 'going_live', mapNumber: 1, map: 'de_mirage' })
    await app.settle()
    return { key, match, say }
  }

  it('holds the match open past series_end until the demo lands', async () => {
    const app = createTestApp({ providers: [createPhantomProvider()] })
    const { key, match, say } = await scripted(app)

    await say({ type: 'series_end', seriesScore: { teamA: 1, teamB: 0 }, winner: 'team_a' })
    await app.settle()
    // Still live, still holding its server: the demo is being written.
    expect((await app.matches.get(key, match.id)).state).toBe('live')
    expect(app.store.rows.servers.find(s => s.matchId === match.id)?.releasedAt).toBeFalsy()

    // Two minutes later — a GOTV delay and a settle — the plugin says what it PUT.
    await app.advance(120_000)
    await say({
      type: 'demo_available',
      mapNumber: 1,
      filename: 'match.dem',
      sizeBytes: 90_000_000,
      sha256: 'b'.repeat(64),
      contentType: 'application/octet-stream',
    })
    await app.playOut()

    expect((await app.matches.get(key, match.id)).state).toBe('ended')
    const order = types(app, match.id)
    expect(order.indexOf('demo.uploaded')).toBeLessThan(order.indexOf('match.ended'))
    expect(
      app.store.rows.events.find(e => e.matchId === match.id && e.payload.type === 'match.ended')
        ?.payload,
    ).toMatchObject({ demo: { uploaded: 1 }, reason: { kind: 'completed' } })
    expect(app.store.rows.servers.find(s => s.matchId === match.id)?.state).toBe('released')
    await app.close()
  })

  it('ends anyway when the demo never comes, and says so', async () => {
    const app = createTestApp({ providers: [createPhantomProvider()] })
    const { key, match, say } = await scripted(app)

    await say({ type: 'series_end', seriesScore: { teamA: 1, teamB: 0 }, winner: 'team_a' })
    await app.settle()
    expect((await app.matches.get(key, match.id)).state).toBe('live')

    await app.playOut()
    expect((await app.matches.get(key, match.id)).state).toBe('ended')
    expect(
      app.store.rows.events.find(e => e.matchId === match.id && e.payload.type === 'match.ended')
        ?.payload,
    ).toMatchObject({ demo: { uploaded: 0, skipped: 'no_demo' }, reason: { kind: 'completed' } })
    expect(app.store.rows.servers.find(s => s.matchId === match.id)?.state).toBe('released')
    await app.close()
  })

  it('does not hold a mode that records no demo, nor one with nowhere to put it', async () => {
    for (const body of [request(), withDemo({ gamemode: 'flying-scoutsman', rules: undefined })]) {
      const app = createTestApp({ providers: [createPhantomProvider()] })
      const { key, match, say } = await scripted(app, body)
      await say({ type: 'series_end', seriesScore: { teamA: 1, teamB: 0 }, winner: 'team_a' })
      await app.settle()
      expect((await app.matches.get(key, match.id)).state).toBe('ended')
      await app.close()
    }
  })
})
