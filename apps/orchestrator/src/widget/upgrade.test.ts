import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eventually } from '@ezpug/core/testing'
import type { MatchRequest, MatchRequestInput, WidgetServerFrame } from '@ezpug/match-api'
import {
  matchRequestSchema,
  WIDGET_CLOSE_CODES,
  WIDGET_COMMAND_RATE_LIMIT,
  WIDGET_SOCKET_PROTOCOL,
} from '@ezpug/match-api'
import type { OrchestratorFrameOf } from '@ezpug/protocol'
import { createFakeServer, type FakeServer } from '@ezpug/protocol/fake-server'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createTestApp, type TestApp } from '../http/testing'
import type { AuthenticatedKey } from '../keys/service'
import { attachServerLink, type ServerLink } from '../link/server-link'
import type { GameServerProvider, ServerConfiguration } from '../providers/provider'
import { attachUpgradeRouter } from '../stream/upgrade'
import { attachWidgetUpgrade, type WidgetUpgrade } from './upgrade'

/**
 * **The widget socket, over a real socket, against a real link** (PRD-02
 * T24): the orchestrator composed over memory on a fake clock, `/link` and
 * `/v1/widget` on one real port, the protocol's fake server dialling in as
 * the plugin would, and a `ws` client playing the widget. A tap crosses the
 * widget socket, the machine, the link — as a `player_command` frame the
 * fake server answers — and comes back as a `command_result`.
 */

const SECRET_ID = 'whsec-1'
const SECRET = 'a-test-secret-of-at-least-thirty-two-chars'
const PROVIDER = 'nodes'

const tk = { steamId64: '76561198279375306', name: 'tk', locale: 'de' } as const
const maex = { steamId64: '76561198279375307', name: 'maex', locale: 'en' } as const
const STRANGER = '76561198000009999'

function request(overrides: Partial<MatchRequestInput> = {}): MatchRequest {
  return matchRequestSchema.parse({
    clientMatchId: 'widget-match-1',
    game: 'cs2',
    gamemode: 'powerup-dm',
    teams: {
      teamA: { name: 'Alle', players: [tk, maex] },
      teamB: { name: 'Niemand', players: [] },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    callbacks: {
      webhookUrl: 'https://platform.invalid/hooks',
      webhookSecretId: SECRET_ID,
      streamAllowedOrigins: ['https://ezpug.com'],
    },
    ttlMinutes: 120,
    ...overrides,
  })
}

interface SocketProvider extends GameServerProvider {
  configured: Map<string, ServerConfiguration>
}

function createSocketProvider(): SocketProvider {
  let counter = 0
  const live = new Map<string, { matchId: string; fleetServerId: string }>()
  const connect = { host: '127.0.0.1', port: 27_415 }
  const tv = { host: '127.0.0.1', port: 27_420, delaySeconds: 90 }
  const provider: SocketProvider = {
    id: PROVIDER,
    configured: new Map(),
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
    stop: () => Promise.resolve(),
    status: serverId =>
      Promise.resolve(live.has(serverId) ? { state: 'running', connect, tv } : { state: 'gone' }),
    deallocate: serverId => {
      live.delete(serverId)
      return Promise.resolve()
    },
    list: () => Promise.resolve([...live].map(([serverId, entry]) => ({ serverId, ...entry }))),
  }
  return provider
}

interface Widget {
  frames: WidgetServerFrame[]
  closed: Promise<{ code: number; reason: string }>
  open: Promise<void>
  send: (frame: unknown) => void
  hello: (token: string) => void
  tap: (correlationId: string, command: string, args?: Record<string, unknown>) => void
  until: (count: number) => Promise<WidgetServerFrame[]>
  close: () => void
}

interface Rig {
  app: TestApp
  provider: SocketProvider
  link: ServerLink
  widgets: WidgetUpgrade
  key: AuthenticatedKey
  url: string
  /** Create a match, let the walk run, dial the fake server in and take it live. */
  liveMatch: (
    overrides?: Partial<MatchRequestInput>,
    onPlayerCommand?: Parameters<typeof createFakeServer>[0]['onPlayerCommand'],
  ) => Promise<{ matchId: string; server: FakeServer; serverId: string }>
  widget: (headers?: Record<string, string>) => Widget
  close: () => Promise<void>
}

const rigs: Rig[] = []

async function createRig(): Promise<Rig> {
  const provider = createSocketProvider()
  // The fake server has no timers of its own, and the clock here moves by
  // the minute (a token's expiry, a relay's deadline): silence must not be a
  // probe in this rig, or the link would terminate a plugin that never
  // heartbeats — `link/server-link.test.ts` proves that path.
  const app = createTestApp({
    providers: [provider],
    deadlines: { heartbeatTimeoutMs: 3_600_000 },
  })
  const server: Server = createServer()
  const router = attachUpgradeRouter(server, { log: app.log })
  const link = attachServerLink({
    router,
    clock: app.clock,
    log: app.log,
    store: app.store,
    matches: app.matches,
    links: app.links,
    heartbeatIntervalMs: 1_800_000,
    isDraining: () => app.draining.value,
  })
  const widgets = attachWidgetUpgrade({
    router,
    clock: app.clock,
    log: app.log,
    widgets: app.widgets,
    isDraining: () => app.draining.value,
  })
  const port = await new Promise<number>(resolve =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  )
  const minted = await app.keys.mint({
    name: 'platform',
    scopes: ['matches'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: SECRET_ID, secret: SECRET }],
  })
  const key = (await app.keys.get(minted.key.id)) as AuthenticatedKey
  const servers: FakeServer[] = []
  const rig: Rig = {
    app,
    provider,
    link,
    widgets,
    key,
    url: `ws://127.0.0.1:${port}`,
    liveMatch: async (overrides, onPlayerCommand) => {
      const { match } = await app.matches.create(key, request(overrides))
      await app.settle()
      const row = app.store.rows.servers.find(s => s.matchId === match.id)
      if (!row?.serverId) throw new Error('the walk left no server')
      const configuration = provider.configured.get(row.serverId)
      if (!configuration) throw new Error('the provider was not configured')
      const fake = createFakeServer({
        url: `${rig.url}/link`,
        token: configuration.link.serverToken,
        hello: { plugins: ['EZPug.Core', 'EZPug.PowerupDm', 'MatchZy'] },
        ...(onPlayerCommand && { onPlayerCommand }),
      })
      servers.push(fake)
      await fake.connect()
      await eventually(() => expect(fake.assignment()).not.toBeNull())
      const source = { provider: PROVIDER, serverId: row.serverId }
      await fake.emit({ type: 'server_ready', matchId: match.id, source, map: 'de_mirage' })
      await fake.emit({
        type: 'player_connected',
        matchId: match.id,
        source,
        player: { steamId64: tk.steamId64, name: tk.name, team: 'team_a' },
      })
      await fake.emit({
        type: 'going_live',
        matchId: match.id,
        source,
        mapNumber: 1,
        map: 'de_mirage',
      })
      await app.settle()
      await eventually(async () =>
        expect((await app.store.findMatch(match.id))?.state).toBe('live'),
      )
      return { matchId: match.id, server: fake, serverId: row.serverId }
    },
    widget: headers => {
      const frames: WidgetServerFrame[] = []
      const socket = new WebSocket(`${rig.url}/v1/widget`, headers ? { headers } : {})
      socket.on('message', data => frames.push(JSON.parse(String(data)) as WidgetServerFrame))
      const widget: Widget = {
        frames,
        open: new Promise<void>((resolve, reject) => {
          socket.once('open', () => resolve())
          socket.once('error', reject)
        }),
        closed: new Promise(resolve =>
          socket.on('close', (code, reason) => resolve({ code, reason: String(reason) })),
        ),
        send: frame => socket.send(JSON.stringify(frame)),
        hello: token => widget.send({ type: 'hello', protocol: WIDGET_SOCKET_PROTOCOL, token }),
        tap: (correlationId, command, args) =>
          widget.send({ type: 'command', correlationId, command, ...(args && { args }) }),
        until: async count => {
          await eventually(() => expect(frames.length).toBeGreaterThanOrEqual(count))
          return frames
        },
        close: () => socket.close(),
      }
      return widget
    },
    close: async () => {
      for (const fake of servers) await fake.close()
      await widgets.close(1001, 'test over')
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

/** Let the orchestrator's clock pass and the world settle. */
async function elapse(rig: Rig, ms: number): Promise<void> {
  await rig.app.clock.advance(ms)
  await rig.app.settle()
}

async function mint(rig: Rig, matchId: string, steamId64: string, ttlSeconds?: number) {
  return rig.app.matches.mintPlayerToken(rig.key, matchId, {
    steamId64,
    ttlSeconds: ttlSeconds ?? 900,
  })
}

describe('the widget socket', () => {
  it('greets with the verbs, relays a tap over the link and answers with what the SDK said', async () => {
    const rig = await createRig()
    const relayed: OrchestratorFrameOf<'player_command'>[] = []
    const { matchId, server, serverId } = await rig.liveMatch({}, frame => {
      relayed.push(frame)
      return frame.args?.kind === 'haste'
        ? { status: 'applied', chargesLeft: 0 }
        : { status: 'rejected', code: 'no_charges', message: 'Keine Ladung mehr.', chargesLeft: 0 }
    })
    const token = await mint(rig, matchId, tk.steamId64)
    const widget = rig.widget({ origin: 'https://ezpug.com' })
    await widget.open
    widget.hello(token.token)
    const [hello] = await widget.until(1)
    expect(hello).toMatchObject({
      type: 'hello',
      protocol: 1,
      matchId,
      steamId64: tk.steamId64,
      gamemode: 'powerup-dm',
      state: 'live',
      locale: 'de',
      commands: [{ name: 'powerup', chargesLeft: 1, readyInMs: 0 }],
    })

    widget.tap('tap-1', 'powerup', { kind: 'haste' })
    const frames = await widget.until(2)
    const first = frames.find(f => f.type === 'command_result')
    expect(first).toEqual({
      type: 'command_result',
      correlationId: 'tap-1',
      command: 'powerup',
      status: 'applied',
      chargesLeft: 0,
    })
    // What crossed the link: the tap as a `player_command` for this player,
    // with the widget's own correlation id.
    expect(relayed).toEqual([
      {
        type: 'player_command',
        correlationId: 'tap-1',
        steamId64: tk.steamId64,
        command: 'powerup',
        args: { kind: 'haste' },
      },
    ])

    // The mode's own plugin_event — emitted by the server as a real mode
    // would — reaches the widget as an `event` frame.
    await server.emit({
      type: 'plugin_event',
      matchId,
      source: { provider: PROVIDER, serverId },
      name: 'powerup_claimed',
      data: { steamId64: tk.steamId64, kind: 'haste' },
    })
    await eventually(() =>
      expect(
        widget.frames.some(
          f =>
            f.type === 'event' &&
            f.envelope.payload.type === 'plugin_event' &&
            f.envelope.payload.name === 'powerup_claimed',
        ),
      ).toBe(true),
    )

    // A refusal from the SDK arrives as it was said, and the hello of a
    // second socket reports what this process learned.
    widget.tap('tap-2', 'powerup')
    await eventually(() =>
      expect(widget.frames.filter(f => f.type === 'command_result').at(-1)).toEqual({
        type: 'command_result',
        correlationId: 'tap-2',
        command: 'powerup',
        status: 'rejected',
        code: 'no_charges',
        message: 'Keine Ladung mehr.',
        chargesLeft: 0,
      }),
    )
    const second = rig.widget({ origin: 'https://ezpug.com' })
    await second.open
    second.hello(token.token)
    const [again] = await second.until(1)
    expect(again).toMatchObject({
      type: 'hello',
      commands: [{ name: 'powerup', chargesLeft: 0, readyInMs: 0 }],
    })
    expect(rig.app.widgets.size(matchId)).toBe(2)
    widget.close()
    second.close()
    await eventually(() => expect(rig.app.widgets.size()).toBe(0))
  })

  it('refuses at the door in the player’s language: an undeclared verb, the rate limit, a server that does not answer', async () => {
    const rig = await createRig()
    const { matchId, server } = await rig.liveMatch({}, () => null)
    const token = await mint(rig, matchId, maex.steamId64)
    const widget = rig.widget()
    await widget.open
    widget.hello(token.token)
    await widget.until(1)
    expect(widget.frames[0]).toMatchObject({ type: 'hello', locale: 'en' })

    widget.tap('fly-1', 'fly')
    await eventually(() =>
      expect(widget.frames.at(-1)).toEqual({
        type: 'command_result',
        correlationId: 'fly-1',
        command: 'fly',
        status: 'rejected',
        code: 'unknown_command',
        message: 'No such command.',
      }),
    )

    // The fake server never answers: the relay deadline says `unavailable`.
    // The deadline is armed when the frame is written, so the clock may only
    // move once the plugin has the frame.
    widget.tap('slow-1', 'powerup')
    await eventually(() =>
      expect(server.received().some(f => f.type === 'player_command')).toBe(true),
    )
    await elapse(rig, 16_000)
    await eventually(() =>
      expect(widget.frames.at(-1)).toEqual({
        type: 'command_result',
        correlationId: 'slow-1',
        command: 'powerup',
        status: 'rejected',
        code: 'unavailable',
        message: 'The server did not answer – try again.',
      }),
    )

    // The bucket: `burst` taps at once, the next one waits.
    const before = widget.frames.length
    for (let i = 0; i < WIDGET_COMMAND_RATE_LIMIT.burst; i += 1) widget.tap(`burst-${i}`, 'fly')
    await widget.until(before + WIDGET_COMMAND_RATE_LIMIT.burst)
    widget.tap('over', 'fly')
    await eventually(() =>
      expect(widget.frames.at(-1)).toMatchObject({
        correlationId: 'over',
        status: 'rejected',
        code: 'rate_limited',
        message: 'Too many taps – wait a moment.',
      }),
    )
    const over = widget.frames.at(-1)
    expect(over?.type === 'command_result' && (over.cooldownMs ?? 0) > 0).toBe(true)
    widget.close()
  })

  it('closes with a decision: no token, a foreign origin, a wrong protocol, a frame before hello, silence', async () => {
    const rig = await createRig()
    const { matchId } = await rig.liveMatch()
    const token = await mint(rig, matchId, tk.steamId64)

    const bad = rig.widget()
    await bad.open
    bad.hello('ezip_not-a-real-token-at-all-0123456789abcdef')
    expect(await bad.closed).toMatchObject({ code: WIDGET_CLOSE_CODES.unauthorized })

    const shaped = rig.widget()
    await shaped.open
    shaped.hello('not-even-our-shape-of-token-0123456789')
    expect(await shaped.closed).toMatchObject({ code: WIDGET_CLOSE_CODES.unauthorized })

    const foreign = rig.widget({ origin: 'https://evil.invalid' })
    await foreign.open
    foreign.hello(token.token)
    expect(await foreign.closed).toMatchObject({ code: WIDGET_CLOSE_CODES.forbidden })

    // The platform's frame is sandboxed without `allow-same-origin`: its
    // origin is opaque and the browser sends the literal `null` — the
    // widget's own door (T25), greeted, never `forbidden`.
    const sandboxed = rig.widget({ origin: 'null' })
    await sandboxed.open
    sandboxed.hello(token.token)
    const [greeted] = await sandboxed.until(1)
    expect(greeted).toMatchObject({ type: 'hello', matchId })
    sandboxed.close()

    const future = rig.widget()
    await future.open
    future.send({ type: 'hello', protocol: 2, token: token.token })
    expect(await future.closed).toMatchObject({ code: WIDGET_CLOSE_CODES.protocolMismatch })

    const eager = rig.widget()
    await eager.open
    eager.tap('x', 'powerup')
    expect(await eager.closed).toMatchObject({ code: WIDGET_CLOSE_CODES.malformed })

    const garbage = rig.widget()
    await garbage.open
    garbage.send({ type: 'dance' })
    expect(await garbage.closed).toMatchObject({ code: WIDGET_CLOSE_CODES.malformed })

    const silent = rig.widget()
    await silent.open
    await eventually(() => expect(rig.widgets.size()).toBe(1))
    await rig.app.clock.advance(10_000)
    expect(await silent.closed).toMatchObject({ code: WIDGET_CLOSE_CODES.helloTimeout })
  })

  it('dies with the match and with its expiry', async () => {
    const rig = await createRig()
    const { matchId, server, serverId } = await rig.liveMatch()
    const short = await mint(rig, matchId, tk.steamId64, 60)
    const widget = rig.widget()
    await widget.open
    widget.hello(short.token)
    await widget.until(1)

    // Expired on the clock: the next tap ends the socket.
    await elapse(rig, 60_000)
    widget.tap('late', 'powerup')
    expect(await widget.closed).toMatchObject({ code: WIDGET_CLOSE_CODES.unauthorized })
    const again = rig.widget()
    await again.open
    again.hello(short.token)
    expect(await again.closed).toMatchObject({ code: WIDGET_CLOSE_CODES.unauthorized })

    const token = await mint(rig, matchId, tk.steamId64)
    const live = rig.widget()
    await live.open
    live.hello(token.token)
    await live.until(1)
    await server.emit({
      type: 'series_end',
      matchId,
      source: { provider: PROVIDER, serverId },
      seriesScore: { teamA: 1, teamB: 0 },
      winner: 'team_a',
    })
    await rig.app.settle()
    const closed = await live.closed
    expect(closed.code).toBe(WIDGET_CLOSE_CODES.matchEnded)
    // The `match.ended` fact arrived before the close.
    expect(
      live.frames.some(f => f.type === 'event' && f.envelope.payload.type === 'match.ended'),
    ).toBe(true)

    // After the end: the hello comes with the terminal state and the close at once.
    const after = rig.widget()
    await after.open
    after.hello(token.token)
    expect(await after.closed).toMatchObject({ code: WIDGET_CLOSE_CODES.matchEnded })
    expect(after.frames[0]).toMatchObject({ type: 'hello', state: 'ended' })

    // And nothing new is minted for it.
    await expect(mint(rig, matchId, tk.steamId64)).rejects.toMatchObject({
      code: 'invalid_state',
    })
  })

  it('mints for the roster, for who joined, for anyone on open join, and for nobody else', async () => {
    const rig = await createRig()
    const dm = await rig.liveMatch()
    // Open join: a stranger gets a token.
    expect((await mint(rig, dm.matchId, STRANGER)).steamId64).toBe(STRANGER)

    const pug = await rig.liveMatch({
      clientMatchId: 'widget-pug',
      gamemode: 'pug',
      teams: { teamA: { name: 'A', players: [tk] }, teamB: { name: 'B', players: [maex] } },
      maps: [{ map: 'de_mirage', sides: 'knife' }],
    })
    expect((await mint(rig, pug.matchId, maex.steamId64)).matchId).toBe(pug.matchId)
    await expect(mint(rig, pug.matchId, STRANGER)).rejects.toMatchObject({
      code: 'player_not_in_match',
    })
    // A stranger who connected is a joined player.
    await pug.server.emit({
      type: 'player_connected',
      matchId: pug.matchId,
      source: { provider: PROVIDER, serverId: pug.serverId },
      player: { steamId64: STRANGER, name: 'walk-in', team: 'spec' },
    })
    await rig.app.settle()
    const walkIn = await mint(rig, pug.matchId, STRANGER)
    expect(walkIn.token.startsWith('ezip_')).toBe(true)
    // Hashed at rest, never in clear; expiry as asked.
    const rows = rig.app.store.rows.playerTokens
    expect(rows.some(row => row.tokenHash === walkIn.token)).toBe(false)
    expect(rows.every(row => row.tokenHash.length === 64)).toBe(true)
    expect(walkIn.expiresAt).toBe(new Date(rig.app.clock.now() + 900_000).toISOString())
  })
})
