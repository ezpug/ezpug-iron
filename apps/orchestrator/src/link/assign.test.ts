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

  /**
   * **A scenario reaches the server as knobs, never as a name to look up**
   * (PRD-03 T11): one language on the wire, one table — `@ezpug/sim`'s — and
   * the plugin holds no second copy of it.
   */
  it('resolves the scenario into what the puppets do', () => {
    expect(compose('powerup-dm', { simulation: { scenario: 'no-show' } }).puppets).toEqual({
      scenario: 'no-show',
      absentPlayers: 2,
      idle: false,
    })
    expect(compose('powerup-dm', { simulation: { scenario: 'idle' } }).puppets).toEqual({
      scenario: 'idle',
      absentPlayers: 0,
      idle: true,
    })
  })

  it('says nothing about puppets for a story that asks for nothing extra', () => {
    // `happy-path` is "play the match out", which is what a room of puppets
    // does anyway — so the frame of every match before T11 is unchanged.
    expect('puppets' in compose('powerup-dm', { simulation: { scenario: 'happy-path' } })).toBe(
      false,
    )
    expect('puppets' in compose('powerup-dm', { simulation: {} })).toBe(false)
    expect('puppets' in compose('pug', { simulation: {} })).toBe(false)
  })

  it('is claimed by every mode this repo ships', () => {
    // **`retakes` was the last holdout and PRD-03 T10 closed it.** cs2-retakes
    // keeps bots out of its *queue* (`QueueManager.AddConnectingPlayer`), which
    // is why the claim waited for a lane run rather than being reasoned: what
    // seats a puppet there is the engine's own `bot_add`, and the plugin's
    // team hook takes the body into its active players like anybody else.
    for (const id of ['pug', 'powerup-dm', 'flying-scoutsman', 'retakes'] as const)
      expect(shippedGamemode(id).capabilities.simulation, id).toBe(true)
  })

  it('seats the roster on one team for a mode with one team', () => {
    // `retakes` is `slots.teams: 1` (T10): the request still has a team A and a
    // team B — that is the wire's shape — and the puppeteer reads the roster
    // off both, so three puppets are three bodies whichever side the plugin
    // puts them on.
    const frame = compose('retakes', { simulation: {} })
    expect(frame.gamemode.slots).toMatchObject({ teams: 1, teamSize: 10 })
    expect(frame.simulation).toEqual({})
  })
})

describe('the assignment and the HUD', () => {
  it('asks no server for a HUD unless the request’s branding says so (PRD-07 T4)', () => {
    for (const id of ['pug', 'powerup-dm', 'flying-scoutsman', 'retakes'] as const) {
      expect('hud' in compose(id), id).toBe(false)
      expect('hud' in compose(id, { branding: { eventName: 'SaarLAN 2026' } }), id).toBe(false)
      expect('hud' in compose(id, { branding: { hud: false } }), id).toBe(false)
      expect(compose(id, { branding: { hud: true } }).hud, id).toBe(true)
    }
  })

  it('hands the server the switch once, and the branding without it', () => {
    // Off is today: a request that never heard of a HUD composes the branding
    // it always did, so the frame's bytes are what they were before T4.
    expect(compose('pug').branding).toEqual({})
    expect(compose('pug', { branding: { eventName: 'SaarLAN 2026' } }).branding).toEqual({
      eventName: 'SaarLAN 2026',
    })
    const frame = compose('pug', {
      branding: {
        eventName: 'SaarLAN 2026',
        tagline: 'Zwei Tage, ein Keller.',
        banner: 'default',
        hud: true,
      },
    })
    expect(frame.branding).toEqual({
      eventName: 'SaarLAN 2026',
      tagline: 'Zwei Tage, ein Keller.',
      banner: 'default',
    })
    expect(frame.hud).toBe(true)
  })
})
