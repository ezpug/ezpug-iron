import { createFakeClock, type FakeClock } from '@ezpug/core'
import { eventually } from '@ezpug/core/testing'
import type { MatchRequestInput } from '@ezpug/match-api'
import {
  createFakeOrchestrator,
  type FakeListener,
  type FakeOrchestrator,
} from '@ezpug/match-api/fake'
import { afterEach, describe, expect, it } from 'vitest'
import { useWidgetLink, type WidgetLink, widgetSocketUrl } from './link'

/**
 * The composable against the published fake over a real socket: the fake
 * listens on Node HTTP with `/v1/widget` as a `ws` upgrade, the composable
 * opens Node's own `WebSocket` at it, and the match is `powerup-dm` played
 * by the simulator on a fake clock — so the round trip a phone makes is the
 * one this test makes, and every deadline on both sides is the clock's.
 */

const PLAYER = { steamId64: '76561198000000001', name: 'Widget', locale: 'de' } as const

interface World {
  clock: FakeClock
  fake: FakeOrchestrator
  listener: FakeListener
  matchId: string
  token: string
}

const opened: { link: WidgetLink; world: World }[] = []
afterEach(async () => {
  for (const { link, world } of opened.splice(0)) {
    link.close()
    // A test may have closed the listener itself (the network-close case).
    await world.listener.close().catch(() => {})
    world.fake.close()
  }
})

async function world(): Promise<World> {
  const clock = createFakeClock()
  const fake = createFakeOrchestrator({
    clock,
    fetch: () => Promise.resolve(new Response(null, { status: 200 })),
  })
  const listener = await fake.listen()
  const key = fake.mintKey({
    name: 'link-test',
    scopes: ['matches'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: 'whsec-test', secret: 'a-test-secret-of-at-least-thirty-two-chars' }],
  })
  const api = fake.client(key.secret)
  const body: MatchRequestInput = {
    clientMatchId: 'link-test',
    game: 'cs2',
    gamemode: 'powerup-dm',
    teams: {
      teamA: { name: 'Widget', players: [PLAYER] },
      teamB: { name: 'Niemand', players: [] },
    },
    maps: [{ map: 'de_mirage', sides: 'ct' }],
    callbacks: {
      webhookUrl: 'https://platform.invalid/hooks',
      webhookSecretId: 'whsec-test',
      streamAllowedOrigins: ['https://ezpug.com'],
    },
    ttlMinutes: 120,
  }
  const created = await api.matches.create({ body })
  const params = { matchId: created.id }
  for (let i = 0; i < 200; i += 1) {
    const match = await api.matches.get({ params })
    if (match.state === 'live') break
    if (match.state === 'failed' || match.state === 'cancelled' || match.state === 'ended')
      throw new Error(`the match ended before going live: ${match.state}`)
    await clock.advance(500)
    await fake.settle()
  }
  const minted = await api.matches.mintPlayerToken({
    params,
    body: { steamId64: PLAYER.steamId64 },
  })
  return { clock, fake, listener, matchId: created.id, token: minted.token }
}

function open(w: World, token: string | null = w.token): WidgetLink {
  const link = useWidgetLink({
    orchestratorUrl: w.listener.url,
    playerToken: token,
    clock: w.clock,
    reconnect: { initialMs: 1_000, maxMs: 4_000 },
  })
  opened.push({ link, world: w })
  return link
}

describe('widgetSocketUrl', () => {
  it('turns the orchestrator’s base URL into the socket’s', () => {
    expect(widgetSocketUrl('https://gs.ezpug.com')).toBe('wss://gs.ezpug.com/v1/widget')
    expect(widgetSocketUrl('http://127.0.0.1:3430/')).toBe('ws://127.0.0.1:3430/v1/widget')
    expect(widgetSocketUrl('https://host.invalid/base/?x=1#f')).toBe(
      'wss://host.invalid/base/v1/widget',
    )
  })
})

describe('useWidgetLink', () => {
  it('is watching with no token and opens nothing', () => {
    const link = useWidgetLink({ orchestratorUrl: 'https://gs.ezpug.com', playerToken: null })
    expect(link.state.value).toBe('watching')
    expect(link.commands.value).toEqual([])
    link.close()
  })

  it('says hello with the token, learns the verbs, taps, sees its tap land, and hears the refusal in German', async () => {
    const w = await world()
    const link = open(w)
    expect(link.state.value).toBe('connecting')
    await eventually(() => expect(link.state.value).toBe('open'))
    expect(link.hello.value).toMatchObject({
      type: 'hello',
      matchId: w.matchId,
      steamId64: PLAYER.steamId64,
      gamemode: 'powerup-dm',
      state: 'live',
      locale: 'de',
    })
    expect(link.commands.value.map(c => c.name)).toEqual(['powerup'])
    expect(link.commands.value[0]).toMatchObject({ chargesLeft: 1, readyAt: w.clock.now() })

    const events: string[] = []
    const off = link.onEvent(envelope => void events.push(envelope.payload.type))
    const applied = await link.send('powerup', { kind: 'speed' })
    expect(applied).toMatchObject({ type: 'command_result', command: 'powerup', status: 'applied' })
    expect(applied.correlationId).toMatch(/^w\d+-[0-9a-z]+:powerup:1$/)
    expect(link.commands.value[0]?.chargesLeft).toBe(0)
    await eventually(() => expect(events).toContain('plugin_event'))
    expect(link.lastEvent.value?.payload.type).toBe('plugin_event')
    off()

    const again = await link.send('powerup', { kind: 'speed' })
    expect(again).toMatchObject({ status: 'rejected', code: 'no_charges' })
    expect(again.message).toMatch(/Leben|Ladung|Aufladung|keine/i)

    const unknown = await link.send('teleport')
    expect(unknown).toMatchObject({ status: 'rejected', code: 'unknown_command' })
  })

  it('hands a mode’s push to onPush and keeps nothing of it', async () => {
    const w = await world()
    const link = open(w)
    await eventually(() => expect(link.state.value).toBe('open'))
    const pushes: { name: string; data: Record<string, unknown> }[] = []
    const off = link.onPush(push => void pushes.push({ name: push.name, data: push.data }))

    const peek = {
      expiresInMs: 5_000,
      self: { x: 1, y: 2, z: 3 },
      contacts: [{ x: 4, y: 5, z: 6 }],
    }
    expect(
      w.fake.widgetPush(w.matchId, PLAYER.steamId64, {
        type: 'push',
        name: 'radar_peek',
        data: peek,
      }),
    ).toBe(1)
    await eventually(() => expect(pushes).toEqual([{ name: 'radar_peek', data: peek }]))
    // A push is not a durable fact: nothing about it lands in `lastEvent`.
    expect(link.lastEvent.value).toBeNull()

    off()
    w.fake.widgetPush(w.matchId, PLAYER.steamId64, { type: 'push', name: 'radar_peek', data: peek })
    await w.clock.advance(1_000)
    expect(pushes).toHaveLength(1)
  })

  it('answers a tap it cannot send as unavailable, and ends with the match', async () => {
    const w = await world()
    const link = open(w)
    await eventually(() => expect(link.state.value).toBe('open'))
    await w.fake.playOut()
    await eventually(() => expect(link.state.value).toBe('ended'))
    expect(link.closeCode.value).toBe(4000)
    expect(link.hello.value).toBeNull()
    const late = await link.send('powerup')
    expect(late).toMatchObject({ status: 'rejected', code: 'not_live' })
    await w.clock.advance(60_000)
    expect(link.state.value).toBe('ended')
  })

  it('refuses for good on a decided close, and retries with a backoff on a network one', async () => {
    const w = await world()
    const bad = open(w, 'ezip_not-a-real-token-at-all-0123456789')
    await eventually(() => expect(bad.state.value).toBe('refused'))
    expect(bad.closeCode.value).toBe(4001)
    await w.clock.advance(60_000)
    expect(bad.state.value).toBe('refused')

    const link = open(w)
    await eventually(() => expect(link.state.value).toBe('open'))
    await w.listener.close()
    await eventually(() => expect(link.state.value).toBe('reconnecting'))
    expect(link.closeCode.value).not.toBeNull()
    expect(link.closeCode.value).not.toBe(4000)
    await w.clock.advance(1_000)
    await eventually(() => expect(link.closeCode.value).toBe(1006))
    expect(link.state.value).toBe('reconnecting')
    expect(w.clock.pending()).toBeGreaterThan(0)
    link.close()
    expect(link.state.value).toBe('closed')
  })
})
