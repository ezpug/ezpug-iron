import { createFakeClock } from '@ezpug/core'
import type { GameserverEvent } from '@ezpug/match-api'
import { shippedGamemode } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { createSimulatedServer, SIM_PLAYER_COMMAND_EVENT } from './server'
import { fixtureAssignment } from './testing'

const powerupDm = shippedGamemode('powerup-dm')
const STRANGER = '76561198000009999'

function harness(openJoin: boolean) {
  const clock = createFakeClock()
  const delivered: GameserverEvent[] = []
  const server = createSimulatedServer({
    clock,
    serverId: 'sim-1',
    seed: 'player-command-test',
    onError: error => {
      throw error
    },
  })
  server.events(event => void delivered.push(event))
  const assignment = fixtureAssignment({ commands: powerupDm.commands, openJoin })
  const tk = assignment.teamA.players[0]?.steamId64 as string
  return { clock, server, delivered, assignment, tk }
}

/**
 * The `powerup-dm` twin (PRD-02 T24): a simulated server answers a widget's
 * tap the way a real plugin's SDK would, and deals the `plugin_event` the
 * platform can prove a tap by — without CS2.
 */
describe('a simulated server and a player command', () => {
  it('refuses a tap before the server runs, then applies one and deals a plugin_event in order', async () => {
    const { clock, server, delivered, assignment, tk } = harness(false)
    server.assign(assignment)
    expect(
      (await server.playerCommand({ steamId64: tk, command: 'powerup' })).result,
    ).toMatchObject({
      status: 'rejected',
      code: 'not_in_match',
    })
    server.start()
    await clock.advance(60_000)
    expect(delivered.some(event => event.type === 'server_ready')).toBe(true)

    const answer = await server.playerCommand({
      steamId64: tk,
      command: 'powerup',
      args: { kind: 'haste' },
    })
    expect(answer.result).toEqual({ status: 'applied', chargesLeft: 0 })
    expect(answer.event).toMatchObject({
      type: 'plugin_event',
      name: SIM_PLAYER_COMMAND_EVENT,
      data: { command: 'powerup', steamId64: tk, name: 'hunzR', args: { kind: 'haste' } },
    })
    // Dealt through the same door as every beat: seq-stamped, delivered, last.
    expect(delivered.at(-1)).toEqual(answer.event)
    expect(answer.event?.seq).toBe(server.status().seq)
    expect(server.commandStates(tk)).toEqual([{ name: 'powerup', chargesLeft: 0, readyInMs: 0 }])
  })

  it('refills a life’s charge when the player’s death is dealt', async () => {
    const { clock, server, delivered, assignment, tk } = harness(false)
    server.assign(assignment)
    server.start()
    await clock.advance(60_000)
    expect((await server.playerCommand({ steamId64: tk, command: 'powerup' })).result.status).toBe(
      'applied',
    )
    expect(
      (await server.playerCommand({ steamId64: tk, command: 'powerup' })).result,
    ).toMatchObject({
      status: 'rejected',
      code: 'no_charges',
      message: 'Keine Ladung mehr übrig.',
    })
    // Play until tk dies once.
    const diedAt = () =>
      delivered.findIndex(event => event.type === 'player_death' && event.victim.steamId64 === tk)
    while (diedAt() < 0 && !server.finished()) await clock.advance(10_000)
    expect(diedAt()).toBeGreaterThanOrEqual(0)
    expect((await server.playerCommand({ steamId64: tk, command: 'powerup' })).result.status).toBe(
      'applied',
    )
  })

  it('takes a stranger for a joined player on an open-join mode and refuses them otherwise', async () => {
    const closed = harness(false)
    closed.server.assign(closed.assignment)
    closed.server.start()
    await closed.clock.advance(60_000)
    expect(
      (await closed.server.playerCommand({ steamId64: STRANGER, command: 'powerup' })).result,
    ).toEqual({
      status: 'rejected',
      code: 'not_in_match',
      message: 'Du bist nicht auf dem Server.',
    })

    const open = harness(true)
    open.server.assign(open.assignment)
    open.server.start()
    await open.clock.advance(60_000)
    const answer = await open.server.playerCommand({ steamId64: STRANGER, command: 'powerup' })
    expect(answer.result).toEqual({ status: 'applied', chargesLeft: 0 })
    expect(answer.event).toMatchObject({ data: { command: 'powerup', steamId64: STRANGER } })
    expect(answer.event && 'name' in (answer.event as { data: object }).data).toBe(false)
  })

  it('refuses an undeclared verb and bad args without dealing anything', async () => {
    const { clock, server, delivered, assignment, tk } = harness(false)
    server.assign(assignment)
    server.start()
    await clock.advance(60_000)
    const before = delivered.length
    expect((await server.playerCommand({ steamId64: tk, command: 'fly' })).result).toMatchObject({
      status: 'rejected',
      code: 'unknown_command',
    })
    expect(
      (await server.playerCommand({ steamId64: tk, command: 'powerup', args: { kind: 'wings' } }))
        .result,
    ).toMatchObject({ status: 'rejected', code: 'invalid_args' })
    expect(delivered.length).toBe(before)
  })
})
