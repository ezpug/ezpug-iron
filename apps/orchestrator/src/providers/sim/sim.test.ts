import { createFakeClock } from '@ezpug/core'
import type {
  GamemodeManifest,
  GameserverEvent,
  MatchRequest,
  MatchRequestInput,
} from '@ezpug/match-api'
import { matchRequestSchema, SHIPPED_GAMEMODES } from '@ezpug/match-api'
import type { RoundBackup } from '@ezpug/protocol'
import { describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from '../../http/testing'
import type { AuthenticatedKey } from '../../keys/service'
import type { ServerEventSink } from '../../link/channels'
import { createLinkRegistry } from '../../link/channels'
import type {
  AllocatedServer,
  GameServerProvider,
  ProvisionedServer,
  ServerConfiguration,
  ServerOffering,
  ServerStatus,
} from '../provider'
import { createSimProvider } from './provider'

const PUG = SHIPPED_GAMEMODES.find(mode => mode.id === 'pug') as GamemodeManifest

/** Match ids the machine would have minted — every event carries one, and it is a uuid. */
const MATCH_ONE = '11111111-1111-4111-8111-111111111111'
const MATCH_TWO = '22222222-2222-4222-8222-222222222222'
const MATCH_THREE = '33333333-3333-4333-8333-333333333333'

/**
 * **The `sim` provider's own surface** (PRD-02 T4, decision 9): the knobs
 * that exist because the server is simulated — step the story by hand, run
 * it at a hundred times real time, make the box flaky, pull its plug — and
 * the two rules around them: they reach a simulated server and nothing else,
 * and a replacement server tells the *same* story, which is what makes a
 * restore from a round backup mean anything (T14 walks that path).
 */

const SECRET_ID = 'whsec-1'
const SECRET = 'a-test-secret-of-at-least-thirty-two-chars'

async function platformKey(app: TestApp): Promise<AuthenticatedKey> {
  const minted = await app.keys.mint({
    name: 'platform',
    scopes: ['matches', 'fleet'],
    // A real monthly ceiling, not `0`: `0` is "no money" (T5), and one of
    // these tests allocates on a stub provider that charges by the hour.
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 100_000 },
    webhookSecrets: [{ id: SECRET_ID, secret: SECRET }],
  })
  return (await app.keys.get(minted.key.id)) as AuthenticatedKey
}

/** One `clientMatchId` per request built here; the door refuses a repeat. */
let requests = 0

function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  requests += 1
  return matchRequestSchema.parse({
    clientMatchId: `sim-request-${requests}`,
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Team A', players: [] },
      teamB: { name: 'Team B', players: [] },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    rules: {
      regulationRounds: 4,
      overtime: { enabled: false, maxRounds: 2, startMoney: 10_000 },
      warmup: { minPlayersToReady: 10, minSpectatorsToReady: 0 },
    },
    callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: SECRET_ID },
    ttlMinutes: 120,
    ...overrides,
  })
}

/** A provider that allocates and then does nothing — a match on real iron, as far as the machine knows. */
function stubProvider(id: string): GameServerProvider {
  let counter = 0
  const alive = new Map<string, ProvisionedServer>()
  return {
    id,
    offerings: () =>
      Promise.resolve([
        {
          capabilities: {
            games: ['cs2'],
            region: 'saarland',
            tickrate: 128,
            lan: false,
            workshopMaps: true,
          },
          hourlyCents: 100,
        },
      ]),
    allocate(allocation): Promise<AllocatedServer> {
      counter += 1
      const serverId = `${id}-${counter}`
      alive.set(serverId, {
        serverId,
        matchId: allocation.matchId,
        fleetServerId: allocation.fleetServerId,
      })
      return Promise.resolve({ serverId, connect: { host: '10.0.0.1', port: 27_015 } })
    },
    configure: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    status: (serverId): Promise<ServerStatus> =>
      Promise.resolve({ state: alive.has(serverId) ? 'running' : 'gone' }),
    deallocate: serverId => {
      alive.delete(serverId)
      return Promise.resolve()
    },
    list: () => Promise.resolve([...alive.values()]),
  }
}

describe('the sim.* commands', () => {
  it('steps a story by hand, changes mode, speed and chaos, and reports the simulator after each', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const key = await platformKey(app)
    const { match } = await app.matches.create(key, request({ sim: { mode: 'step' } }))
    await app.settle()

    // In step mode nothing is armed: the server sits configured and silent
    // until a beat is dealt by hand.
    expect((await app.matches.get(key, match.id)).state).toBe('configuring')
    const first = await app.matches.command(key, match.id, {
      type: 'sim.step',
      correlationId: 's1',
    })
    expect(first.status).toBe('applied')
    expect(first.stepped).toBe('server_ready')
    expect(first.sim).toMatchObject({ mode: 'step', timeScale: 1, finished: false })
    expect(first.sim?.remainingBeats).toBeGreaterThan(0)
    await app.settle()
    expect((await app.matches.get(key, match.id)).state).toBe('ready')

    const speed = await app.matches.command(key, match.id, {
      type: 'sim.speed',
      correlationId: 's2',
      timeScale: 60,
    })
    expect(speed.sim?.timeScale).toBe(60)

    const chaos = await app.matches.command(key, match.id, {
      type: 'sim.chaos',
      correlationId: 's3',
      chaos: { duplicate: 1 },
    })
    expect(chaos.sim?.chaos).toEqual({ duplicate: 1 })
    const honest = await app.matches.command(key, match.id, {
      type: 'sim.chaos',
      correlationId: 's4',
      chaos: null,
    })
    expect(honest.sim?.chaos).toBeNull()

    // Back on the clock, the story deals itself and the match ends.
    const auto = await app.matches.command(key, match.id, {
      type: 'sim.mode',
      correlationId: 's5',
      mode: 'auto',
    })
    expect(auto.sim?.mode).toBe('auto')
    const stepInAuto = await app.matches.command(key, match.id, {
      type: 'sim.step',
      correlationId: 's6',
    })
    expect(stepInAuto).toMatchObject({ status: 'rejected', code: 'invalid_state' })

    await app.playOut()
    const final = await app.matches.get(key, match.id)
    expect(final.state).toBe('ended')
    expect(final.sim).toMatchObject({ finished: true, outcome: 'completed' })
    await app.close()
  })

  it('pulls the plug: the box is gone, the match recovers and fails server_lost with no backup', async () => {
    const app = createTestApp({ sim: { positionTickIntervalMs: null } })
    const key = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    // The walk is enqueued, not awaited: settle once before advancing the
    // clock, or the allocate deadline fires on a match nobody has started
    // provisioning yet.
    await app.settle()
    for (let i = 0; i < 200 && (await app.matches.get(key, match.id)).state !== 'live'; i += 1) {
      await app.clock.next()
      await app.settle()
    }
    expect((await app.matches.get(key, match.id)).state).toBe('live')

    const killed = await app.matches.command(key, match.id, {
      type: 'sim.kill',
      correlationId: 'k1',
    })
    expect(killed.status).toBe('applied')
    const serverId = (await app.matches.get(key, match.id)).serverId as string
    expect(await app.sim.status(serverId)).toMatchObject({ state: 'gone' })

    // Nothing announces a box that lost power: the machine notices the
    // heartbeats stopped, probes the provider and opens the window itself.
    await app.playOut()
    const final = await app.matches.get(key, match.id)
    expect(final.state).toBe('failed')
    expect(final.endedReason?.kind).toBe('server_lost')
    expect(app.store.rows.servers.every(row => row.releasedAt !== null)).toBe(true)
    expect(app.sim.size()).toBe(0)
    await app.close()
  })

  it('refuses the family on a server that is not simulated', async () => {
    const app = createTestApp({ noProviders: true })
    app.providers.register(stubProvider('iron'))
    const key = await platformKey(app)
    const { match } = await app.matches.create(key, request())
    await app.settle()
    // Nothing is `ready`, so the match view shows no server yet — the ledger
    // row is where the provider that took it is written.
    expect(app.store.rows.servers[0]?.provider).toBe('iron')
    const refused = await app.matches.command(key, match.id, {
      type: 'sim.speed',
      correlationId: 'x1',
      timeScale: 10,
    })
    expect(refused).toMatchObject({ status: 'rejected', code: 'command_unsupported' })
    expect(refused.message).toContain('iron')
    await app.close()
  })
})

describe('the sim provider', () => {
  /** One provider, off the machine: allocate, configure, play, restore. */
  function rig() {
    const clock = createFakeClock({ start: '2026-09-05T18:00:00.000Z' })
    const events: { serverId: string; event: GameserverEvent }[] = []
    const backups: { serverId: string; backup: RoundBackup }[] = []
    const sink: ServerEventSink = {
      ingest: (source, event) => {
        events.push({ serverId: source.serverId, event })
        return Promise.resolve('accepted')
      },
      backup: (source, backup) => {
        backups.push({ serverId: source.serverId, backup })
        return Promise.resolve(true)
      },
    }
    const sim = createSimProvider({ clock, sink, links: createLinkRegistry() })
    const configuration = (
      serverId: string,
      matchId: string,
      overrides: Partial<MatchRequestInput> = {},
    ): ServerConfiguration => ({
      matchId,
      game: 'cs2',
      request: request(overrides),
      gamemode: PUG,
      joinPassword: 'not-a-secret',
      link: { url: `ws://localhost:3430/link#${serverId}`, serverToken: 'ezis_not-a-secret' },
    })
    const playOut = async (serverId: string): Promise<void> => {
      for (let i = 0; i < 20_000; i += 1) {
        if (sim.engine(serverId)?.finished() ?? true) return
        if (clock.pending() === 0) return
        await clock.next()
      }
      throw new Error('the story never finished')
    }
    return { clock, sim, events, backups, configuration, playOut }
  }

  const allocation = (matchId: string, offering: ServerOffering) => ({
    matchId,
    fleetServerId: `fleet-${matchId}`,
    keyId: 'key-1',
    requirements: { game: 'cs2' as const },
    offering,
    ttlMinutes: 60,
  })

  async function play(matchId: string, overrides: Partial<MatchRequestInput> = {}) {
    const world = rig()
    const [offering] = await world.sim.offerings()
    if (!offering) throw new Error('the sim offered nothing')
    const { serverId } = await world.sim.allocate(allocation(matchId, offering))
    await world.sim.configure(serverId, world.configuration(serverId, matchId, overrides))
    await world.sim.start(serverId)
    await world.playOut(serverId)
    return { ...world, serverId, offering }
  }

  it('tells one story per match, not one per server — the seed a replacement inherits', async () => {
    const first = await play(MATCH_ONE)
    const second = await play(MATCH_ONE)
    expect(first.sim.engine(first.serverId)?.status().sim?.seed).toBe(`sim#${MATCH_ONE}`)
    expect(second.events.map(({ event }) => event.type)).toEqual(
      first.events.map(({ event }) => event.type),
    )
    const other = await play(MATCH_TWO)
    expect(other.sim.engine(other.serverId)?.status().sim?.seed).toBe(`sim#${MATCH_TWO}`)
  })

  it("says the request's warmup lines while it waits, as a real server prints them", async () => {
    const warmupLines = ['Willkommen bei EZPug.', 'Dein Match steht auf ezpug.com.']
    const world = await play(MATCH_ONE, { warmupLines })
    const spoken = world.events
      .map(({ event }) => event)
      .filter(event => event.type === 'plugin_event' && event.name === 'chat_announced')
    expect(spoken.length).toBeGreaterThan(1)
    const lineOf = (event: GameserverEvent): unknown =>
      event.type === 'plugin_event' ? event.data.line : undefined
    expect(spoken.map(lineOf)).toEqual(
      spoken.map((_, index) => warmupLines[index % warmupLines.length]),
    )
    // Warmup only: every one of them is spoken before the map goes live.
    const types = world.events.map(({ event }) => event.type)
    const live = types.indexOf('going_live')
    expect(live).toBeGreaterThan(-1)
    for (const event of spoken) expect(types.indexOf(event.type)).toBeLessThan(live)

    // And a request that named none says nothing at all.
    const quiet = await play(MATCH_TWO)
    expect(
      quiet.events.filter(
        ({ event }) => event.type === 'plugin_event' && event.name === 'chat_announced',
      ),
    ).toHaveLength(0)
  })

  it('keeps an event it spoke in sight until the machine has taken it (T10a)', async () => {
    // A sink that answers when this test says so — a stand-in for the
    // machine holding a match's chain while the story deals its next beat.
    const clock = createFakeClock({ start: '2026-09-05T18:00:00.000Z' })
    const answer: (() => void)[] = []
    const sink: ServerEventSink = {
      ingest: () =>
        new Promise(resolve => {
          answer.push(() => resolve('accepted'))
        }),
      backup: () => Promise.resolve(true),
    }
    const sim = createSimProvider({ clock, sink, links: createLinkRegistry() })
    const [offering] = await sim.offerings()
    if (!offering) throw new Error('the sim offered nothing')
    const { serverId } = await sim.allocate(allocation(MATCH_ONE, offering))
    await sim.configure(serverId, {
      matchId: MATCH_ONE,
      game: 'cs2',
      request: request(),
      gamemode: PUG,
      joinPassword: 'not-a-secret',
      link: { url: `ws://localhost:3430/link#${serverId}`, serverToken: 'ezis_not-a-secret' },
    })
    await sim.start(serverId)
    expect(sim.pending()).toBe(0)

    // The story speaks from a timer callback; nobody awaits what it starts.
    for (let beat = 0; beat < 10 && sim.pending() === 0; beat += 1) await clock.next()
    expect(sim.pending()).toBeGreaterThan(0)

    let crossed = false
    const barrier = sim.settle().then(() => {
      crossed = true
    })
    // Time does not move and no microtask can finish an ingest nobody
    // answered: a barrier that returned here would be lying.
    await clock.advance(0)
    expect(crossed).toBe(false)

    for (const resolve of answer.splice(0)) resolve()
    await barrier
    expect(crossed).toBe(true)
    expect(sim.pending()).toBe(0)
  })

  it('restores a replacement server from a round backup and plays the match out on it', async () => {
    const world = await play(MATCH_THREE)
    const backups = world.sim.engine(world.serverId)?.backups() ?? []
    const backup = backups[1] ?? backups[0]
    if (!backup) throw new Error('the story wrote no backup')

    const replacement = await world.sim.allocate(allocation(MATCH_THREE, world.offering))
    await world.sim.configure(
      replacement.serverId,
      world.configuration(replacement.serverId, MATCH_THREE),
    )
    expect(
      await world.sim.restore?.(replacement.serverId, { ...backup, content: 'not-a-real-backup' }),
    ).toBe(true)
    const before = world.events.length
    await world.sim.start(replacement.serverId)
    await world.playOut(replacement.serverId)

    const resumed = world.events.slice(before).map(({ event }) => event.type)
    expect(resumed[0]).toBe('server_ready')
    expect(resumed).toContain('plugin_event')
    expect(resumed.at(-1)).toBe('series_end')
    expect(world.sim.engine(replacement.serverId)?.finished()).toBe(true)
  })

  it('answers false for a restore onto a server it has not got', async () => {
    const world = rig()
    expect(
      await world.sim.restore?.('sim-nobody', {
        mapNumber: 1,
        roundNumber: 1,
        filename: 'ezpug_match_round1.txt',
        content: 'not-a-real-backup',
      }),
    ).toBe(false)
  })
})
