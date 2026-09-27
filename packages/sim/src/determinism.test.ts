/**
 * The determinism test (PRD-01 T5, the extended tier's second suite): same
 * seed, same clock, byte-equal event log — with the ephemeral tier, the
 * heartbeats, the announcements and the server's own chaos all included,
 * because every one of them draws from the seed or the clock and nothing else.
 */
import { createFakeClock } from '@ezpug/core'
import type { GameserverEvent } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import type { MatchAssignment } from './assignment'
import type { SimPlan } from './server'
import { createSimulatedServer } from './server'
import { fixtureAssignment } from './testing'

async function play(
  plan: SimPlan,
  seed = 'determinism',
  overrides: Partial<MatchAssignment> = {},
): Promise<string[]> {
  const clock = createFakeClock()
  const server = createSimulatedServer({
    clock,
    serverId: 'sim-1',
    seed,
    onError: error => {
      throw error
    },
  })
  const log: string[] = []
  server.events((event: GameserverEvent) => log.push(JSON.stringify(event)))
  server.assign(fixtureAssignment(overrides), plan)
  server.start()
  await clock.advance(45_000)
  await server.announce('Halbzeit-Trivia: Wer hat 2019 gewonnen?')
  await clock.runAll()
  server.close()
  return log
}

describe('determinism', () => {
  it('same seed, same clock: a byte-equal event log', async () => {
    const one = await play({ scenario: 'overtime' })
    const two = await play({ scenario: 'overtime' })
    expect(one.length).toBeGreaterThan(200)
    expect(one.join('\n')).toBe(two.join('\n'))
  })

  it('holds with the server’s own chaos armed — the dice are the seed’s', async () => {
    const plan: SimPlan = {
      scenario: 'pauses',
      chaos: { delay: 0.3, duplicate: 0.2, delayMs: 5_000 },
    }
    const one = await play(plan)
    const two = await play(plan)
    expect(one.join('\n')).toBe(two.join('\n'))
    expect(new Set(one).size).toBeLessThan(one.length)
  })

  it('holds for a tower map: the line, the walk and every round of Rush (PRD-06 T2)', async () => {
    const three = (players: MatchAssignment['teamA']['players']) => players.slice(0, 3)
    const base = fixtureAssignment()
    const rush: Partial<MatchAssignment> = {
      teamA: { ...base.teamA, players: three(base.teamA.players) },
      teamB: { ...base.teamB, players: three(base.teamB.players) },
      maps: [{ map: 'rush_001', teamASide: 'ct' }],
      flow: 'none',
      records: 'events',
    }
    const one = await play({ scenario: 'rush-convoy' }, 'rush', rush)
    const two = await play({ scenario: 'rush-convoy' }, 'rush', rush)
    expect(one.filter(line => line.includes('"tower"')).length).toBeGreaterThan(15)
    expect(one.join('\n')).toBe(two.join('\n'))
    const other = await play({ scenario: 'happy-path' }, 'rush-b', rush)
    expect(other.join('\n')).not.toBe(one.join('\n'))
  })

  it('a different seed tells a different match', async () => {
    const one = await play({ scenario: 'happy-path' }, 'a')
    const two = await play({ scenario: 'happy-path' }, 'b')
    expect(one.join('\n')).not.toBe(two.join('\n'))
  })
})
