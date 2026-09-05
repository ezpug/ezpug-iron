import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { eventually } from '@ezpug/core/testing'
import type { GameserverEvent, MatchRequest, MatchRequestInput } from '@ezpug/match-api'
import { matchRequestSchema, rosterEntrySchema, shippedGamemode } from '@ezpug/match-api'
import { FIXTURE_MATCH_ID, stringifyRecording } from '@ezpug/match-api/fixtures'
import { HEARTBEAT_INTERVAL_MS_DEFAULT, LINK_CLOSE_CODES, PROTOCOL_VERSION } from '@ezpug/protocol'
import {
  createFakeServer,
  type FakeServer,
  type FakeServerOptions,
  LinkClosedError,
  type LinkClosure,
  type LinkExchangeEntry,
  type LinkSocketConstructor,
  scrubLinkExchange,
} from '@ezpug/protocol/fake-server'
import { FIXTURE_SERVER_TOKEN } from '@ezpug/protocol/fixtures'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from '../http/testing'
import type { AuthenticatedKey } from '../keys/service'
import type { GameServerProvider, ServerConfiguration } from '../providers/provider'
import { attachUpgradeRouter } from '../stream/upgrade'
import type { ServerRef } from './channels'
import { attachServerLink, COMMAND_TIMEOUT_MS_DEFAULT, type ServerLink } from './server-link'

/**
 * **The link, over a real socket** (PRD-02 T6): the orchestrator composed
 * over memory on a fake clock, its `/link` upgrade on a real port, and the
 * fake server from `@ezpug/protocol/fake-server` dialling in as a plugin
 * would — behind a provider whose servers are nothing but sockets. What
 * crossed the wire in the flows below is recorded, scrubbed, into
 * `packages/protocol/fixtures/link/*.json`, the files the C# client is
 * proven against; `EZPUG_IRON_RECORD=1` rewrites them.
 */

const LINK_FIXTURES = fileURLToPath(
  new URL('../../../../packages/protocol/fixtures/link/', import.meta.url),
)
const RECORDING = process.env.EZPUG_IRON_RECORD === '1'

const SECRET_ID = 'whsec-1'
const SECRET = 'a-test-secret-of-at-least-thirty-two-chars'
const PROVIDER = 'nodes'

const tk = {
  steamId64: '76561198279375306',
  name: 'tk',
  locale: 'de',
  rating: 1820,
  rankName: 'Eisen III',
  loadout: {
    t: { knife: 'weapon_knife_karambit' },
    ct: { weapons: [{ defindex: 60, paintId: 1231 }] },
  },
} as const
const maex = { steamId64: '76561198279375307', name: 'maex', locale: 'en' } as const

function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  return matchRequestSchema.parse({
    clientMatchId: 'platform-match-1',
    game: 'cs2',
    gamemode: 'pug',
    teams: {
      teamA: { name: 'Team tk', players: [tk] },
      teamB: { name: 'Team maex', players: [maex] },
    },
    maps: [{ map: 'de_mirage', sides: 'knife' }],
    rules: {
      regulationRounds: 2,
      overtime: { enabled: false, maxRounds: 2, startMoney: 10_000 },
      warmup: { minPlayersToReady: 2, minSpectatorsToReady: 0 },
      cvars: { mp_freezetime: '15', mp_maxrounds: '30' },
    },
    callbacks: {
      webhookUrl: 'https://platform.invalid/hooks',
      webhookSecretId: SECRET_ID,
      demoUploadUrl: 'http://127.0.0.1:9400/demos/fixture.dem?X-Amz-Signature=fixture',
    },
    warmupLines: ['Willkommen bei EZPug.', 'Welcome to EZPug.'],
    branding: { hostname: 'EZPug · SaarLAN 2026 · Mirage', eventName: 'SaarLAN 2026' },
    ttlMinutes: 120,
    ...overrides,
  })
}

/** A provider whose servers exist only as the sockets that dial in — the test's stand-in for a node. */
interface SocketProvider extends GameServerProvider {
  configured: Map<string, ServerConfiguration>
  gone: Set<string>
  stopped: string[]
}

function createSocketProvider(): SocketProvider {
  let counter = 0
  const live = new Map<string, { matchId: string; fleetServerId: string }>()
  const connect = { host: '127.0.0.1', port: 27_415 }
  const tv = { host: '127.0.0.1', port: 27_420, delaySeconds: 90 }
  const provider: SocketProvider = {
    id: PROVIDER,
    configured: new Map(),
    gone: new Set(),
    stopped: [],
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
      return Promise.resolve({ serverId, connect, tv })
    },
    configure: (serverId, configuration) => {
      provider.configured.set(serverId, configuration)
      return Promise.resolve()
    },
    start: () => Promise.resolve(),
    stop: serverId => {
      provider.stopped.push(serverId)
      return Promise.resolve()
    },
    status: serverId =>
      Promise.resolve(
        provider.gone.has(serverId) || !live.has(serverId)
          ? { state: 'gone' }
          : { state: 'running', connect, tv },
      ),
    deallocate: serverId => {
      live.delete(serverId)
      return Promise.resolve()
    },
    list: () => Promise.resolve([...live].map(([serverId, entry]) => ({ serverId, ...entry }))),
  }
  return provider
}

interface LinkRig {
  app: TestApp
  provider: SocketProvider
  link: ServerLink
  url: string
  key: AuthenticatedKey
  /** Create a match, let the walk run, and hand back what the fake needs to dial in. */
  startMatch: (overrides?: Partial<MatchRequestInput>) => Promise<{
    matchId: string
    serverId: string
    token: string
    ref: ServerRef
  }>
  dial: (token: string, options?: Partial<FakeServerOptions>) => FakeServer
  close: () => Promise<void>
}

const rigs: LinkRig[] = []

async function createLinkRig(
  options: { heartbeatIntervalMs?: number; helloTimeoutMs?: number } = {},
): Promise<LinkRig> {
  const provider = createSocketProvider()
  const app = createTestApp({ providers: [provider] })
  const server: Server = createServer()
  const router = attachUpgradeRouter(server, { log: app.log })
  const link = attachServerLink({
    router,
    clock: app.clock,
    log: app.log,
    store: app.store,
    matches: app.matches,
    links: app.links,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    helloTimeoutMs: options.helloTimeoutMs,
    isDraining: () => app.draining.value,
  })
  const port = await new Promise<number>(resolve =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  )
  const minted = await app.keys.mint({
    name: 'platform',
    scopes: ['matches', 'fleet', 'admin'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: SECRET_ID, secret: SECRET }],
  })
  const key = (await app.keys.get(minted.key.id)) as AuthenticatedKey
  const rig: LinkRig = {
    app,
    provider,
    link,
    url: `ws://127.0.0.1:${port}/link`,
    key,
    startMatch: async overrides => {
      const { match } = await app.matches.create(key, request(overrides))
      await app.settle()
      const row = app.store.rows.servers.find(s => s.matchId === match.id)
      if (!row?.serverId) throw new Error('the walk left no server')
      const configuration = provider.configured.get(row.serverId)
      if (!configuration) throw new Error('the provider was not configured')
      expect(configuration.link.url).toBe('ws://localhost:3430/link')
      return {
        matchId: match.id,
        serverId: row.serverId,
        token: configuration.link.serverToken,
        ref: { provider: PROVIDER, serverId: row.serverId },
      }
    },
    dial: (token, fakeOptions) => createFakeServer({ url: rig.url, token, ...fakeOptions }),
    close: async () => {
      await link.close()
      await app.close()
      await new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
  rigs.push(rig)
  return rig
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close()
})

/** The vocabulary events a server speaks, stamped with its match and source. */
function eventsFor(matchId: string, serverId: string) {
  const source = { provider: PROVIDER, serverId }
  const player = (entry: { steamId64: string; name: string }, team: 'team_a' | 'team_b') => ({
    steamId64: entry.steamId64,
    name: entry.name,
    team,
  })
  const at = (event: GameserverEvent): GameserverEvent => event
  return {
    serverReady: at({ type: 'server_ready', matchId, source, map: 'de_mirage' }),
    tkJoins: at({ type: 'player_connected', matchId, source, player: player(tk, 'team_a') }),
    maexJoins: at({ type: 'player_connected', matchId, source, player: player(maex, 'team_b') }),
    goingLive: at({ type: 'going_live', matchId, source, mapNumber: 1, map: 'de_mirage' }),
    paused: at({
      type: 'match_paused',
      matchId,
      source,
      mapNumber: 1,
      kind: 'admin',
      pausedBy: 'admin',
    }),
    tick: at({
      type: 'position_tick',
      matchId,
      source,
      mapNumber: 1,
      roundNumber: 1,
      positions: [{ steamId64: tk.steamId64, x: -412.5, y: 1180, z: 64, yaw: 92.5 }],
    }),
    seriesEnd: at({
      type: 'series_end',
      matchId,
      source,
      seriesScore: { teamA: 1, teamB: 0 },
      winner: 'team_a',
    }),
    forAnotherMatch: at({
      type: 'server_ready',
      matchId: FIXTURE_MATCH_ID,
      source,
      map: 'de_nuke',
    }),
  }
}

/** The golden under `fixtures/link/`: written when recording, compared as bytes otherwise. */
function golden(name: string, entries: LinkExchangeEntry[], replacements: Record<string, string>) {
  const produced = stringifyRecording(scrubLinkExchange(entries, replacements))
  const path = `${LINK_FIXTURES}${name}.json`
  if (RECORDING) {
    mkdirSync(LINK_FIXTURES, { recursive: true })
    writeFileSync(path, produced)
    return
  }
  expect(existsSync(path), `no link fixture ${name} — run with EZPUG_IRON_RECORD=1`).toBe(true)
  expect(produced).toBe(readFileSync(path, 'utf8'))
}

const serverRow = (app: TestApp, serverId: string) =>
  app.store.rows.servers.find(row => row.serverId === serverId)

describe('the link', () => {
  it('says welcome to a hello, assigns the match, and plays it out over the socket', async () => {
    const rig = await createLinkRig()
    const { app, key, provider } = rig
    const { matchId, serverId, token, ref } = await rig.startMatch()
    const events = eventsFor(matchId, serverId)
    const record: LinkExchangeEntry[] = []
    const fake = rig.dial(token, {
      record,
      hello: { map: 'de_dust2' },
      onCommand: command => {
        // A real plugin reports the pause before it answers the command that
        // caused it, and does not wait for the ack (which cannot come until
        // the command's step releases the match's chain): the answer must
        // not queue behind the event on either side.
        if (command.type === 'pause') void fake.emit(events.paused)
        if (command.type === 'rcon')
          return { status: 'applied', output: 'hostname: EZPug dev server' }
        return undefined
      },
    })

    const welcome = await fake.connect()
    expect(welcome).toEqual({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      provider: PROVIDER,
      serverId,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS_DEFAULT,
      ackedSeq: 0,
    })
    expect(app.links.get(ref)).toBeDefined()
    expect(rig.link.get(ref)).toMatchObject({ server: ref, matchId, ackedSeq: 0 })

    // The assignment: the request, the manifest and the ledger, composed once.
    const assign = await fake.next('assign')
    const pug = shippedGamemode('pug')
    expect(assign).toMatchObject({
      matchId,
      game: 'cs2',
      gamemode: { id: 'pug', flow: 'matchzy', plugins: pug.plugins },
      plugins: [...pug.plugins, 'WeaponPaints'],
      cfg: pug.cfg,
      cvars: {
        ...pug.cvars,
        mp_freezetime: '15',
        mp_maxrounds: '2',
        mp_overtime_enable: '0',
        mp_overtime_maxrounds: '2',
        mp_overtime_startmoney: '10000',
      },
      maps: [{ map: 'de_mirage', sides: 'knife' }],
      teams: { teamA: { name: 'Team tk', players: [tk] }, teamB: { players: [maex] } },
      warmupLines: ['Willkommen bei EZPug.', 'Welcome to EZPug.'],
      branding: { hostname: 'EZPug · SaarLAN 2026 · Mirage', eventName: 'SaarLAN 2026' },
      demoUploadUrl: 'http://127.0.0.1:9400/demos/fixture.dem?X-Amz-Signature=fixture',
    })
    expect(assign.gamemode).not.toHaveProperty('maps')
    expect(assign.gamemode).not.toHaveProperty('widget')
    expect(assign.matchzyConfig).toBeUndefined()
    expect(assign.restore).toBeUndefined()
    expect(fake.matchId()).toBe(matchId)

    // What hello said is on the row; the state the plugin reports follows.
    await eventually(() => expect(serverRow(app, serverId)?.linkState).toBe('assigned'))
    expect(serverRow(app, serverId)).toMatchObject({
      versions: { plugin: '0.1.0', counterStrikeSharp: '1.0.373' },
      hostname: 'EZPug dev server',
      currentMap: 'de_dust2',
      lastSeenAt: app.clock.date(),
    })
    expect(app.store.rows.serverTokens[0]?.lastUsedAt).toEqual(app.clock.date())

    // The match, over the socket: every event acked, the transitions the machine's.
    expect(await fake.emit(events.serverReady)).toEqual([{ seq: 1, status: 'accepted' }])
    await app.settle()
    const ready = await app.matches.get(key, matchId)
    expect(ready.state).toBe('ready')
    expect(ready.connect).toMatchObject({ host: '127.0.0.1', port: 27_415 })
    expect(await fake.emit([events.tkJoins, events.maexJoins, events.goingLive])).toEqual([
      { seq: 2, status: 'accepted' },
      { seq: 3, status: 'accepted' },
      { seq: 4, status: 'accepted' },
    ])
    await app.settle()
    expect((await app.matches.get(key, matchId)).state).toBe('live')
    expect(fake.buffered()).toEqual([])

    // A backup crosses the link and lands in the store.
    fake.backup({
      mapNumber: 1,
      roundNumber: 2,
      filename: 'matchzy_1_map1_round1.cfg',
      content: '"round" {}\n',
    })
    await eventually(() => expect(app.store.rows.backups).toHaveLength(1))
    expect(app.store.rows.backups[0]).toMatchObject({
      matchId,
      roundNumber: 2,
      content: '"round" {}\n',
    })

    // A heartbeat is a fact on the row, once the write interval has passed.
    await app.clock.advance(HEARTBEAT_INTERVAL_MS_DEFAULT)
    fake.heartbeat({ playerCount: 2 })
    await eventually(() =>
      expect(serverRow(app, serverId)?.lastSeenAt?.getTime()).toBe(app.clock.now()),
    )

    // Commands relayed by correlation id; the pause's event lands before the answer.
    const paused = await app.matches.command(key, matchId, {
      type: 'pause',
      correlationId: 'cmd-0001',
    })
    expect(paused).toMatchObject({ correlationId: 'cmd-0001', type: 'pause', status: 'applied' })
    expect(
      app.store.rows.events.filter(e => e.matchId === matchId).map(e => e.payload.type),
    ).toContain('match_paused')
    const rcon = await app.matches.command(key, matchId, {
      type: 'rcon',
      correlationId: 'cmd-0002',
      command: 'hostname',
    })
    expect(rcon).toMatchObject({ status: 'applied', output: 'hostname: EZPug dev server' })
    const announced = await app.matches.command(key, matchId, {
      type: 'announce',
      correlationId: 'cmd-0003',
      text: 'GLHF — viel Erfolg!',
    })
    expect(announced.status).toBe('applied')
    expect(fake.received().filter(f => f.type === 'command')).toHaveLength(3)

    // The end: the server is told `release` before the provider stops it.
    expect(await fake.emit(events.seriesEnd)).toEqual([{ seq: 6, status: 'accepted' }])
    await app.settle()
    expect((await app.matches.get(key, matchId)).state).toBe('ended')
    const release = await fake.next('release')
    expect(release.reason).toBe('ended: completed')
    expect(fake.matchId()).toBeUndefined()
    expect(provider.stopped).toEqual([serverId])
    expect(serverRow(app, serverId)).toMatchObject({ state: 'released', linkAckedSeq: 6 })
    expect(app.links.size()).toBe(0)
    await eventually(() => expect(serverRow(app, serverId)?.linkState).toBe('idle'))
    await rig.link.settle()

    const closure = await fake.close()
    expect(closure.code).toBe(1000)
    await eventually(() => expect(rig.link.sessions()).toEqual([]))
    golden('match', record, { [matchId]: FIXTURE_MATCH_ID, [token]: FIXTURE_SERVER_TOKEN })
  })

  it('refuses at the door with the close code that says why', async () => {
    const rig = await createLinkRig({ helloTimeoutMs: 1_000 })
    const { app } = rig
    const { matchId, serverId, token } = await rig.startMatch()
    const record: LinkExchangeEntry[] = []
    const closedWith = async (fake: FakeServer): Promise<LinkClosure> => {
      try {
        await fake.connect()
      } catch (error) {
        if (error instanceof LinkClosedError) return error.closure
        throw error
      }
      throw new Error('expected the link to refuse')
    }
    /** A bare socket that says `text` on open, and how the orchestrator closed it. */
    const rawClose = (
      text: string,
      before?: (socket: { send: (data: string) => void }) => Promise<void>,
    ) =>
      new Promise<LinkClosure>(resolve => {
        const Socket = (globalThis as { WebSocket: LinkSocketConstructor }).WebSocket
        const socket = new Socket(rig.url)
        socket.addEventListener('close', event =>
          resolve({ code: event.code ?? 1006, reason: event.reason ?? '' }),
        )
        socket.addEventListener('open', () => {
          if (before) void before(socket).then(() => socket.send(text))
          else socket.send(text)
        })
      })

    // A token nobody minted (shaped like one, so the lookup runs), and one that is not even shaped like ours.
    expect(
      await closedWith(rig.dial('ezis_not-a-secret_unknown_token_0000000000', { record })),
    ).toEqual({
      code: LINK_CLOSE_CODES.unauthorized,
      reason: 'unknown or revoked token',
    })
    expect((await closedWith(rig.dial('plain-text-0123456789'))).code).toBe(
      LINK_CLOSE_CODES.unauthorized,
    )
    // The first frame is hello.
    expect(
      await rawClose(
        JSON.stringify({
          type: 'heartbeat',
          state: 'idle',
          map: 'de_dust2',
          playerCount: 0,
          uptimeMs: 1,
        }),
      ),
    ).toEqual({ code: LINK_CLOSE_CODES.malformed, reason: 'the first frame is hello' })
    // A protocol this build does not speak, before the frame is even parsed.
    expect(await rawClose(JSON.stringify({ type: 'hello', protocol: 2, token }))).toEqual({
      code: LINK_CLOSE_CODES.protocolMismatch,
      reason: `protocol 2; this orchestrator speaks ${PROTOCOL_VERSION}`,
    })
    // Not JSON at all; a frame that does not parse.
    expect((await rawClose('{not json')).code).toBe(LINK_CLOSE_CODES.malformed)
    expect(await rawClose(JSON.stringify({ type: 'teleport' }))).toMatchObject({
      code: LINK_CLOSE_CODES.malformed,
    })
    // No hello inside the timeout — the timer is the clock's.
    expect(
      await rawClose('', async () => {
        await app.clock.advance(1_000)
      }),
    ).toEqual({ code: LINK_CLOSE_CODES.helloTimeout, reason: 'no hello within 1000 ms' })

    // The right token, then the match is cancelled: the row closes and the token opens nothing.
    const fake = rig.dial(token, { record })
    await fake.connect()
    await fake.next('assign')
    await app.matches.cancel(rig.key, matchId)
    await app.settle()
    expect(await fake.next('release')).toMatchObject({ reason: 'cancelled: cancelled' })
    await eventually(() => expect(serverRow(app, serverId)?.linkState).toBe('idle'))
    await fake.close()
    expect(await closedWith(rig.dial(token, { record }))).toEqual({
      code: LINK_CLOSE_CODES.unauthorized,
      reason: 'no open server for this token',
    })
    expect(app.log.lines.join('\n')).not.toContain(token)
    golden('refusals', record, { [matchId]: FIXTURE_MATCH_ID, [token]: FIXTURE_SERVER_TOKEN })
  })

  it('acks every event by its link seq: duplicates, ephemerals, strangers, and gaps', async () => {
    const rig = await createLinkRig()
    const { app, key } = rig
    const { matchId, serverId, token, ref } = await rig.startMatch()
    const events = eventsFor(matchId, serverId)
    const record: LinkExchangeEntry[] = []
    const fake = rig.dial(token, { record })
    await fake.connect()
    await fake.next('assign')

    expect(await fake.emit([events.serverReady, events.tkJoins])).toEqual([
      { seq: 1, status: 'accepted' },
      { seq: 2, status: 'accepted' },
    ])
    // The same seq again: nothing happens, the server drops it from its buffer.
    fake.resend({ seq: 2, event: events.tkJoins })
    // A position tick is broadcast, never logged; an event for another
    // match is refused with a reason; a batch that arrived out of order is
    // taken whole and the contiguous ack moves only once the gap closes.
    const acks = fake.emit([events.tick, events.forAnotherMatch])
    fake.send({
      type: 'events',
      events: [
        { seq: 6, event: events.goingLive },
        { seq: 5, event: events.maexJoins },
      ],
    })
    expect(await acks).toEqual([
      { seq: 3, status: 'ephemeral' },
      { seq: 4, status: 'rejected' },
    ])
    await app.settle()
    const ack = fake
      .received()
      .filter(frame => frame.type === 'ack')
      .map(frame => (frame.type === 'ack' ? frame.results : []))
    expect(ack[1]).toEqual([{ seq: 2, status: 'duplicate' }])
    expect(ack[2]).toEqual([
      { seq: 3, status: 'ephemeral' },
      {
        seq: 4,
        status: 'rejected',
        message: `names match ${FIXTURE_MATCH_ID}; this server holds ${matchId}`,
      },
    ])
    expect(ack[3]).toEqual([
      { seq: 6, status: 'accepted' },
      { seq: 5, status: 'accepted' },
    ])
    expect(rig.link.get(ref)?.ackedSeq).toBe(6)
    expect(serverRow(app, serverId)?.linkAckedSeq).toBe(6)
    const logged = app.store.rows.events.filter(e => e.matchId === matchId).map(e => e.payload.type)
    expect(logged.filter(type => type === 'player_connected')).toHaveLength(2)
    expect(logged).not.toContain('position_tick')
    expect((await app.matches.get(key, matchId)).state).toBe('live')
    await fake.close()
    golden('events', record, { [matchId]: FIXTURE_MATCH_ID, [token]: FIXTURE_SERVER_TOKEN })
  })

  it('resumes a reconnecting server from welcome.ackedSeq and replaces a duplicate socket', async () => {
    const rig = await createLinkRig()
    const { app, key } = rig
    const { matchId, serverId, token } = await rig.startMatch()
    const events = eventsFor(matchId, serverId)
    const record: LinkExchangeEntry[] = []
    const fake = rig.dial(token, { record })
    await fake.connect()
    await fake.next('assign')
    await fake.emit([events.serverReady, events.tkJoins, events.maexJoins])
    await app.settle()
    expect((await app.matches.get(key, matchId)).state).toBe('ready')

    // The socket drops; the plugin keeps playing and buffers what it could not send.
    await fake.close()
    await eventually(() => expect(rig.link.sessions()).toEqual([]))
    const acked = fake.emit(events.goingLive)
    expect(fake.buffered().map(entry => entry.seq)).toEqual([4])

    // Back: hello says which match it holds and how far it got; welcome says
    // how far we got; the gap is resent, and no second assignment is made.
    const welcome = await fake.connect()
    expect(welcome.ackedSeq).toBe(3)
    expect(await acked).toEqual([{ seq: 4, status: 'accepted' }])
    await app.settle()
    expect((await app.matches.get(key, matchId)).state).toBe('live')
    expect(fake.received().filter(frame => frame.type === 'assign')).toHaveLength(1)
    expect(fake.received().filter(frame => frame.type === 'welcome')).toHaveLength(2)

    // A second socket with the same token wins; the first is told so.
    const twin = rig.dial(token, { record })
    const replaced = fake.closed()
    await twin.connect()
    expect(await replaced).toEqual({
      code: LINK_CLOSE_CODES.replaced,
      reason: 'replaced by a newer socket',
    })
    expect(rig.link.sessions()).toHaveLength(1)
    expect(app.links.size()).toBe(1)
    // The twin is a fresh process with the same token: its counter starts
    // over and ours follows it rather than calling its events duplicates, and
    // it does not hold the match, so it is assigned.
    expect(twin.received().find(frame => frame.type === 'welcome')).toMatchObject({ ackedSeq: 0 })
    expect(await twin.next('assign')).toMatchObject({ matchId })
    expect(await twin.emit(events.tick)).toEqual([{ seq: 1, status: 'ephemeral' }])
    await twin.close()
    golden('reconnect', record, { [matchId]: FIXTURE_MATCH_ID, [token]: FIXTURE_SERVER_TOKEN })
  })

  it('relays commands, player commands, profiles and the console by correlation id, with a deadline', async () => {
    const rig = await createLinkRig()
    const { app, key } = rig
    const { matchId, serverId, token, ref } = await rig.startMatch()
    const events = eventsFor(matchId, serverId)
    const record: LinkExchangeEntry[] = []
    const fake = rig.dial(token, {
      record,
      uptimeMs: 421_000,
      onCommand: command => (command.type === 'unpause' ? null : undefined),
      onPlayerCommand: () => ({
        status: 'rejected',
        code: 'cooldown',
        message: 'Noch 4 Sekunden.',
        cooldownMs: 4_000,
        chargesLeft: 0,
      }),
    })
    fake.consoleLines.push(
      { uptimeMs: 420_900, line: 'L 09/05/2026 - 18:00:00: World triggered "Round_Start"' },
      { uptimeMs: 420_950, line: '[EZPug] state: live' },
    )
    await fake.connect()
    await fake.next('assign')
    await fake.emit([events.serverReady, events.tkJoins, events.goingLive])
    await app.settle()

    // The Match API's own commands cross verbatim.
    const kick = await app.matches.command(key, matchId, {
      type: 'kick',
      correlationId: 'cmd-0007',
      steamId64: tk.steamId64,
      reason: 'afk',
    })
    expect(kick.status).toBe('applied')
    const profile = await app.matches.command(key, matchId, {
      type: 'profile',
      correlationId: 'cmd-0012',
      player: { ...maex, rating: 1500, rankName: 'Bronze I' },
    })
    expect(profile.status).toBe('applied')
    expect(
      fake
        .received()
        .filter(frame => frame.type === 'command')
        .map(frame => frame.type === 'command' && frame.command.type),
    ).toEqual(['kick', 'profile'])

    // The sim family never reaches a real server.
    const step = await app.matches.command(key, matchId, {
      type: 'sim.step',
      correlationId: 'cmd-0013',
    })
    expect(step).toMatchObject({ status: 'rejected', code: 'command_unsupported' })
    expect(fake.received().filter(frame => frame.type === 'command')).toHaveLength(2)

    // The link's own verbs: a profile push, a widget's tap, the console tail.
    const channel = app.links.get(ref)
    if (!channel?.profile || !channel.playerCommand || !channel.console || !channel.consoleTail)
      throw new Error('the link channel lacks a verb')
    await channel.profile(rosterEntrySchema.parse({ ...tk, rating: 1900 }))
    await eventually(() => expect(fake.profiles()).toHaveLength(1))
    expect(fake.profiles()[0]).toMatchObject({ steamId64: tk.steamId64, rating: 1900 })
    const tap = await channel.playerCommand({
      correlationId: 'pc-0001',
      steamId64: tk.steamId64,
      command: 'powerup',
      args: { kind: 'speed' },
    })
    expect(tap).toEqual({
      correlationId: 'pc-0001',
      steamId64: tk.steamId64,
      command: 'powerup',
      status: 'rejected',
      code: 'cooldown',
      message: 'Noch 4 Sekunden.',
      cooldownMs: 4_000,
      chargesLeft: 0,
    })
    expect(channel.consoleTail()).toBeUndefined()
    const tail = await channel.console(50)
    expect(tail.lines).toHaveLength(2)
    expect(tail.uptimeMs).toBe(421_000)
    expect(tail.at).toEqual(app.clock.date())
    expect(channel.consoleTail()).toBe(tail)
    expect(rig.link.get(ref)?.consoleTail).toBe(tail)
    // An unsolicited tail replaces the cache.
    fake.console([{ uptimeMs: 421_100, line: '[EZPug] demo uploading' }])
    const cached = channel.consoleTail
    await eventually(() => expect(cached()?.lines[0]?.line).toBe('[EZPug] demo uploading'))

    // A command nobody answers is `provider_unavailable` once the deadline passes.
    const unanswered = app.matches.command(key, matchId, {
      type: 'unpause',
      correlationId: 'cmd-0004',
    })
    // The deadline is armed when the frame is written, on the clock as it
    // stands then: wait for the frame before moving the clock.
    await eventually(() =>
      expect(
        fake.received().some(frame => frame.type === 'command' && frame.command.type === 'unpause'),
      ).toBe(true),
    )
    await app.clock.advance(COMMAND_TIMEOUT_MS_DEFAULT)
    expect(await unanswered).toMatchObject({
      correlationId: 'cmd-0004',
      status: 'rejected',
      code: 'provider_unavailable',
    })
    // The command's own correlation id is reusable after it timed out: a
    // replay answers from the store, not the socket.
    expect(
      await app.matches.command(key, matchId, { type: 'unpause', correlationId: 'cmd-0004' }),
    ).toMatchObject({ code: 'provider_unavailable' })
    await fake.close()
    golden('commands', record, { [matchId]: FIXTURE_MATCH_ID, [token]: FIXTURE_SERVER_TOKEN })
  })

  it('probes the provider after two silent intervals, and opens the recovery window when the server is gone', async () => {
    const rig = await createLinkRig()
    const { app, key, provider } = rig
    const { matchId, serverId, token, ref } = await rig.startMatch()
    const events = eventsFor(matchId, serverId)
    const fake = rig.dial(token)
    await fake.connect()
    await fake.next('assign')
    await fake.emit([events.serverReady, events.tkJoins, events.goingLive])
    await app.settle()
    expect((await app.matches.get(key, matchId)).state).toBe('live')
    fake.backup({
      mapNumber: 1,
      roundNumber: 3,
      filename: 'matchzy_1_map1_round2.cfg',
      content: '"round" {}\n',
    })
    await eventually(() => expect(app.store.rows.backups).toHaveLength(1))

    // Heartbeats alone keep a quiet server alive past the loss detector.
    for (let beat = 0; beat < 6; beat += 1) {
      await app.clock.advance(HEARTBEAT_INTERVAL_MS_DEFAULT)
      fake.heartbeat({ playerCount: 2 })
      await eventually(() =>
        expect(serverRow(app, serverId)?.lastSeenAt?.getTime()).toBe(app.clock.now()),
      )
      await app.settle()
    }
    expect((await app.matches.get(key, matchId)).state).toBe('live')
    expect(fake.connected()).toBe(true)

    // Silence with the provider saying `running`: the socket is dropped so
    // the plugin reconnects; the match is untouched.
    const dropped = fake.closed()
    await app.clock.advance(2 * HEARTBEAT_INTERVAL_MS_DEFAULT)
    expect((await dropped).code).toBe(1006)
    await app.settle()
    expect((await app.matches.get(key, matchId)).state).toBe('live')
    expect(app.links.get(ref)).toBeUndefined()
    expect(app.log.lines.join('\n')).toContain(`link ${PROVIDER}/${serverId}: silent for`)
    await fake.connect()
    expect(app.links.get(ref)).toBeDefined()

    // Silence with the provider saying `gone`: the window opens with the
    // newest backup's round, and closes `server_lost` when nothing resumes it.
    provider.gone.add(serverId)
    await app.clock.advance(2 * HEARTBEAT_INTERVAL_MS_DEFAULT)
    await app.settle()
    await eventually(async () =>
      expect((await app.matches.get(key, matchId)).state).toBe('recovering'),
    )
    const recovering = app.store.rows.events.find(
      e => e.matchId === matchId && e.payload.type === 'match.recovering',
    )
    expect(recovering?.payload).toMatchObject({ backupRound: 3 })
    expect(serverRow(app, serverId)).toMatchObject({ state: 'failed' })
    await app.advance(5 * 60_000)
    const failed = await app.matches.get(key, matchId)
    expect(failed.state).toBe('failed')
    expect(failed.endedReason).toMatchObject({ kind: 'server_lost' })
  })

  it('refuses an assignment the image cannot honour, and tells every session when it shuts down', async () => {
    const rig = await createLinkRig()
    const { app, key } = rig
    const { matchId, token } = await rig.startMatch()
    const bare = rig.dial(token, { hello: { plugins: ['EZPug.Core'] } })
    await bare.connect()
    expect(await bare.next('release')).toMatchObject({ reason: 'failed: provider_error' })
    await app.settle()
    const failed = await app.matches.get(key, matchId)
    expect(failed.state).toBe('failed')
    expect(failed.endedReason?.detail).toContain('lacks MatchZy')
    expect(bare.received().filter(frame => frame.type === 'assign')).toHaveLength(0)

    const second = await rig.startMatch({ clientMatchId: 'platform-match-2' })
    const fake = rig.dial(second.token)
    await fake.connect()
    await fake.next('assign')
    expect(rig.link.sessions()).toHaveLength(2)
    const closures = Promise.all([bare.closed(), fake.closed()])
    await rig.link.close()
    expect(await closures).toEqual([
      { code: LINK_CLOSE_CODES.shuttingDown, reason: 'the orchestrator is shutting down' },
      { code: LINK_CLOSE_CODES.shuttingDown, reason: 'the orchestrator is shutting down' },
    ])
    await eventually(() => expect(rig.link.sessions()).toEqual([]))
    // A drained orchestrator refuses the upgrade outright.
    await expect(rig.dial(second.token).connect()).rejects.toBeInstanceOf(LinkClosedError)
  })
})
