import { type MatchRequestInput, matchRequestSchema, shippedGamemode } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { composeAssign } from './assign'

/**
 * **The request's `simulation` reaches the server** (PRD-03 T7). One field
 * switches puppets on for every flow; who seats them is the server's to
 * work out from the manifest it is handed — MatchZy's simulation mode under
 * a `matchzy` flow (the switch is inside `matchzyConfig` too), the SDK's
 * puppeteer under any other.
 */

const MATCH_ID = '7f3a1c22-2b64-4a5f-9c31-0d5e6f8a1b20'

type ShippedId = Parameters<typeof shippedGamemode>[0]

function compose(gamemode: ShippedId, overrides: Partial<MatchRequestInput> = {}) {
  const request = matchRequestSchema.parse({
    clientMatchId: 'platform-match-27',
    game: 'cs2',
    gamemode,
    teams: {
      teamA: { name: 'A', players: [{ steamId64: '76561198279375306', name: 'tk' }] },
      teamB: { name: 'B', players: [{ steamId64: '76561198279375307', name: 'maex' }] },
    },
    maps: [{ map: 'de_dust2', sides: 'ct' }],
    callbacks: { webhookUrl: 'https://platform.invalid/hooks', webhookSecretId: 'whsec-1' },
    ttlMinutes: 60,
    ...overrides,
  })
  const manifest = shippedGamemode(gamemode)
  return composeAssign({ matchId: MATCH_ID, request, manifest, installed: manifest.plugins })
}

describe('the assignment of a match of puppets', () => {
  it('carries the simulation block as it was asked, for an SDK mode', () => {
    const frame = compose('powerup-dm', { simulation: { timeScale: 2 } })
    expect(frame.simulation).toEqual({ timeScale: 2 })
    expect(frame.matchzyConfig).toBeUndefined()
  })

  it('carries it beside MatchZy’s own switch under a matchzy flow', () => {
    const frame = compose('pug', { simulation: {} })
    expect(frame.simulation).toEqual({})
    expect(frame.matchzyConfig).toMatchObject({ simulation: true })
  })

  it('is absent from a real match, so the frame is byte for byte what it was', () => {
    expect('simulation' in compose('powerup-dm')).toBe(false)
  })

  it('is claimed by every mode the SDK seats puppets for', () => {
    for (const id of ['pug', 'powerup-dm', 'flying-scoutsman'] as const)
      expect(shippedGamemode(id).capabilities.simulation, id).toBe(true)
    // cs2-retakes keeps bots out of its queue; the claim waits for T10's lane case.
    expect(shippedGamemode('retakes').capabilities.simulation).toBe(false)
  })
})
