import { createFakeClock } from '@ezpug/core'
import type { PlayerCommandSpec } from '@ezpug/match-api'
import { shippedGamemode } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import { createSimCommandTable, simCommandLine } from './commands'

const TK = '76561198279375306'
const MAEX = '76561198279375307'

const powerup = shippedGamemode('powerup-dm').commands[0] as PlayerCommandSpec
const dash: PlayerCommandSpec = {
  name: 'dash',
  title: { de: 'Sprint', en: 'Dash' },
  cooldownMs: 5_000,
  charges: { count: 2, per: 'round' },
}
const wave: PlayerCommandSpec = {
  name: 'wave',
  title: { de: 'Winken', en: 'Wave' },
  cooldownMs: 0,
  charges: null,
}

function table(locales: Record<string, 'de' | 'en'> = {}) {
  const clock = createFakeClock()
  const commands = createSimCommandTable({
    clock,
    commands: [powerup, dash, wave],
    localeOf: steamId64 => locales[steamId64],
  })
  return { clock, commands }
}

/**
 * The SDK's `CommandTable` in TypeScript: the same refusal order, the same
 * periods, so the platform's tests against the fake see what a real server
 * would answer.
 */
describe('the simulated command table', () => {
  it('refuses in the SDK’s order: unknown verb, bad args, cooldown, no charges', async () => {
    const { clock, commands } = table({ [TK]: 'en' })
    expect(commands.run({ steamId64: TK, command: 'fly' })).toEqual({
      status: 'rejected',
      code: 'unknown_command',
      message: 'No such command.',
    })
    expect(commands.run({ steamId64: TK, command: 'powerup', args: { kind: 'wings' } })).toEqual({
      status: 'rejected',
      code: 'invalid_args',
      message: 'The arguments do not fit.',
    })
    expect(commands.run({ steamId64: TK, command: 'dash' })).toEqual({
      status: 'applied',
      chargesLeft: 1,
    })
    expect(commands.run({ steamId64: TK, command: 'dash' })).toEqual({
      status: 'rejected',
      code: 'cooldown',
      message: 'Not ready yet.',
      cooldownMs: 5_000,
      chargesLeft: 1,
    })
    await clock.advance(5_000)
    expect(commands.run({ steamId64: TK, command: 'dash' })).toEqual({
      status: 'applied',
      chargesLeft: 0,
    })
    await clock.advance(5_000)
    expect(commands.run({ steamId64: TK, command: 'dash' })).toEqual({
      status: 'rejected',
      code: 'no_charges',
      message: 'No charges left.',
      chargesLeft: 0,
    })
  })

  it('spends a charge only on an applied tap and refills it when its period turns', () => {
    const { commands } = table()
    expect(commands.run({ steamId64: TK, command: 'powerup', args: { kind: 'haste' } })).toEqual({
      status: 'applied',
      chargesLeft: 0,
    })
    expect(commands.run({ steamId64: TK, command: 'powerup' })).toMatchObject({
      status: 'rejected',
      code: 'no_charges',
      message: 'Keine Ladung mehr übrig.',
    })
    // A round turning refills `dash` (per round), not `powerup` (per life).
    commands.reset('round')
    expect(commands.run({ steamId64: TK, command: 'powerup' })).toMatchObject({
      code: 'no_charges',
    })
    // tk dies: their life refills, maex's is untouched.
    commands.run({ steamId64: MAEX, command: 'powerup' })
    commands.reset('life', TK)
    expect(commands.run({ steamId64: TK, command: 'powerup' })).toEqual({
      status: 'applied',
      chargesLeft: 0,
    })
    expect(commands.run({ steamId64: MAEX, command: 'powerup' })).toMatchObject({
      code: 'no_charges',
    })
  })

  it('never runs out of a verb without charges and reports the state a hello needs', async () => {
    const { clock, commands } = table()
    for (let i = 0; i < 5; i += 1)
      expect(commands.run({ steamId64: TK, command: 'wave' })).toEqual({ status: 'applied' })
    commands.run({ steamId64: TK, command: 'dash' })
    await clock.advance(1_000)
    expect(commands.stateOf(TK)).toEqual([
      { name: 'powerup', chargesLeft: 1, readyInMs: 0 },
      { name: 'dash', chargesLeft: 1, readyInMs: 4_000 },
      { name: 'wave', chargesLeft: null, readyInMs: 0 },
    ])
    commands.forget(TK)
    expect(commands.stateOf(TK)).toEqual([
      { name: 'powerup', chargesLeft: 1, readyInMs: 0 },
      { name: 'dash', chargesLeft: 2, readyInMs: 0 },
      { name: 'wave', chargesLeft: null, readyInMs: 0 },
    ])
  })

  it('speaks German by default and English to who asked for it', () => {
    expect(simCommandLine('cooldown', undefined)).toBe('Noch nicht wieder bereit.')
    expect(simCommandLine('cooldown', 'en')).toBe('Not ready yet.')
    expect(simCommandLine('not_in_match', 'de')).toBe('Du bist nicht auf dem Server.')
  })
})
