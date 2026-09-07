import { describe, expect, it } from 'vitest'
import { envelopeFixture, GAMESERVER_EVENT_FIXTURES } from '../fixtures'
import { shippedGamemode } from '../gamemodes'
import {
  WIDGET_CLIENT_FRAME_TYPES,
  WIDGET_CLOSE_CODES,
  WIDGET_COMMAND_RATE_LIMIT,
  WIDGET_COMMAND_REFUSALS,
  WIDGET_SERVER_FRAME_TYPES,
  WIDGET_SOCKET_PATH,
  WIDGET_SOCKET_PROTOCOL,
  widgetClientFrameSchema,
  widgetServerFrameSchema,
} from './socket'

const TOKEN = 'fake-player-token-0123456789abcdef'

describe('the widget socket frames', () => {
  it('opens with a hello that carries the token and the protocol, and taps with commands', () => {
    const hello = widgetClientFrameSchema.parse({
      type: 'hello',
      protocol: WIDGET_SOCKET_PROTOCOL,
      token: TOKEN,
    })
    expect(hello.type).toBe('hello')
    const tap = widgetClientFrameSchema.parse({
      type: 'command',
      correlationId: 'tap-1',
      command: 'powerup',
      args: { kind: 'speed' },
    })
    expect(tap.type).toBe('command')
    expect(WIDGET_CLIENT_FRAME_TYPES).toEqual(['hello', 'command'])
  })

  it('refuses a hello on another protocol, a short token, and a verb outside the grammar', () => {
    expect(
      widgetClientFrameSchema.safeParse({ type: 'hello', protocol: 2, token: TOKEN }).success,
    ).toBe(false)
    expect(
      widgetClientFrameSchema.safeParse({ type: 'hello', protocol: 1, token: 'short' }).success,
    ).toBe(false)
    expect(
      widgetClientFrameSchema.safeParse({
        type: 'command',
        correlationId: 'x',
        command: 'Power Up',
      }).success,
    ).toBe(false)
  })

  it('answers with a hello of declared commands and their state, events, and command results', () => {
    const manifest = shippedGamemode('powerup-dm')
    const spec = manifest.commands[0]
    if (!spec) throw new Error('powerup-dm declares a command')
    const welcome = widgetServerFrameSchema.parse({
      type: 'hello',
      protocol: WIDGET_SOCKET_PROTOCOL,
      matchId: '6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
      steamId64: '76561198279375306',
      gamemode: manifest.id,
      state: 'live',
      locale: 'de',
      commands: [{ ...spec, chargesLeft: 1, readyInMs: 0 }],
    })
    expect(welcome.type).toBe('hello')
    const event = widgetServerFrameSchema.parse({
      type: 'event',
      envelope: envelopeFixture(GAMESERVER_EVENT_FIXTURES.plugin_event),
    })
    expect(event.type).toBe('event')
    const result = widgetServerFrameSchema.parse({
      type: 'command_result',
      correlationId: 'tap-1',
      command: 'powerup',
      status: 'rejected',
      code: 'no_charges',
      message: 'Kein Power-up mehr in diesem Leben.',
      chargesLeft: 0,
    })
    expect(result.type).toBe('command_result')
    // The push: a mode's own name and its own shape, which this contract does
    // not read (PRD-02 T26).
    const push = widgetServerFrameSchema.parse({
      type: 'push',
      name: 'radar_peek',
      data: { expiresInMs: 5_000, self: { x: 1, y: 2, z: 3 }, contacts: [{ x: 4, y: 5, z: 6 }] },
    })
    expect(push.type).toBe('push')
    expect(
      widgetServerFrameSchema.safeParse({ type: 'push', name: 'Radar Peek', data: {} }).success,
    ).toBe(false)
    expect(widgetServerFrameSchema.safeParse({ type: 'push', name: 'radar_peek' }).success).toBe(
      false,
    )
    expect(WIDGET_SERVER_FRAME_TYPES).toEqual(['hello', 'event', 'command_result', 'push'])
  })

  it('never carries a position tick — a phone has no radar', () => {
    expect(widgetServerFrameSchema.safeParse({ type: 'tick', ticks: [] }).success).toBe(false)
  })

  it('has a refusal set that starts with the SDK’s seven and adds the door’s three', () => {
    expect(WIDGET_COMMAND_REFUSALS.slice(0, 7)).toEqual([
      'cooldown',
      'no_charges',
      'unknown_command',
      'invalid_args',
      'not_in_match',
      'not_alive',
      'refused',
    ])
    expect(WIDGET_COMMAND_REFUSALS.slice(7)).toEqual(['rate_limited', 'not_live', 'unavailable'])
  })

  it('pins the path, the close codes and the rate limit', () => {
    expect(WIDGET_SOCKET_PATH).toBe('/v1/widget')
    expect(WIDGET_CLOSE_CODES.matchEnded).toBe(4000)
    expect(WIDGET_CLOSE_CODES.unauthorized).toBe(4001)
    expect(new Set(Object.values(WIDGET_CLOSE_CODES)).size).toBe(
      Object.keys(WIDGET_CLOSE_CODES).length,
    )
    for (const code of Object.values(WIDGET_CLOSE_CODES)) {
      expect(code).toBeGreaterThanOrEqual(4000)
      expect(code).toBeLessThan(5000)
    }
    expect(WIDGET_COMMAND_RATE_LIMIT).toEqual({ burst: 10, perSecond: 2 })
  })
})
