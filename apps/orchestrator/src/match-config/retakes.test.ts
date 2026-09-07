import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type GamemodeManifest, shippedGamemode } from '@ezpug/match-api'
import { describe, expect, it } from 'vitest'
import {
  buildRetakesConfig,
  MAX_PLAYERS_RANGE,
  pluginConfigsFor,
  RETAKES_ALLOCATOR_PLUGIN,
  RETAKES_PLUGIN,
} from './retakes'

/**
 * **cs2-retakes' config file, pinned** (PRD-02 T23): the golden beside this
 * test is what `RetakesPlugin` is handed at load, and upstream's own
 * `BaseConfigs` — transcribed here from
 * `plugins/vendor/cs2-retakes/RetakesPlugin/Configs/BaseConfigs.cs` — says
 * every key in it is one the plugin reads and every value is in range.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const golden = (name: string): unknown =>
  JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8'))

const retakes = (): GamemodeManifest => shippedGamemode('retakes')
const both = [RETAKES_PLUGIN, RETAKES_ALLOCATOR_PLUGIN]

describe('the retakes plugin config', () => {
  it('is the golden a retakes server loads', () => {
    expect(buildRetakesConfig({ manifest: retakes(), plugins: both })).toEqual(
      golden('retakes-open-join'),
    )
  })

  it('carries only keys the plugin has, in the sections it has them', () => {
    // `BaseConfigs`, its sections and their properties. A key that is not
    // here is a key `System.Text.Json` silently drops, and a setting nobody
    // would ever notice was not applied.
    const upstream: Record<string, readonly string[]> = {
      GameSettings: [
        'MaxPlayers',
        'MinimumPlayers',
        'ShouldBreakBreakables',
        'ShouldOpenDoors',
        'EnableFallbackAllocation',
      ],
      QueueSettings: [
        'QueuePriorityFlag',
        'QueueImmunityFlag',
        'ShouldRemoveSpectators',
        'ShouldAutoJoinSpectators',
        'ShouldAutoJoinGame',
      ],
    }
    const config = buildRetakesConfig({ manifest: retakes(), plugins: both }) as unknown as Record<
      string,
      Record<string, unknown>
    >
    for (const [section, keys] of Object.entries(config)) {
      expect(upstream[section], `${section} is not a section of BaseConfigs`).toBeDefined()
      for (const key of Object.keys(keys)) expect(upstream[section]).toContain(key)
    }
  })

  it('takes the head count from the manifest and keeps it inside what the spawns hold', () => {
    const wide = { ...retakes(), slots: { teamSize: 16, teams: 2, openJoin: true } }
    const narrow = { ...retakes(), slots: { teamSize: 1, teams: 1, openJoin: true } }
    expect(buildRetakesConfig({ manifest: wide, plugins: both }).GameSettings.MaxPlayers).toBe(
      MAX_PLAYERS_RANGE.max,
    )
    expect(buildRetakesConfig({ manifest: narrow, plugins: both }).GameSettings.MaxPlayers).toBe(
      MAX_PLAYERS_RANGE.min,
    )
  })

  it('leaves the plugin allocating for itself when the image has no allocator', () => {
    expect(
      buildRetakesConfig({ manifest: retakes(), plugins: [RETAKES_PLUGIN] }).GameSettings
        .EnableFallbackAllocation,
    ).toBe(true)
  })

  it('opens the join exactly when the manifest does', () => {
    const closed = { ...retakes(), slots: { ...retakes().slots, openJoin: false } }
    expect(
      buildRetakesConfig({ manifest: closed, plugins: both }).QueueSettings.ShouldAutoJoinGame,
    ).toBe(false)
  })

  it('never lets a CounterStrikeSharp admin flag decide who keeps a slot', () => {
    // The hard don't: one permission mechanism, and it is API-key scopes.
    // Upstream defaults both of these to a `@css/vip` entry.
    const { QueuePriorityFlag, QueueImmunityFlag } = buildRetakesConfig({
      manifest: retakes(),
      plugins: both,
    }).QueueSettings
    expect(QueuePriorityFlag).toEqual([])
    expect(QueueImmunityFlag).toEqual([])
  })
})

describe('the assignment’s plugin configs', () => {
  it('are keyed by plugin folder, and there are none for a mode with no such plugin', () => {
    expect(pluginConfigsFor(retakes(), both)).toEqual({
      [RETAKES_PLUGIN]: golden('retakes-open-join'),
    })
    expect(pluginConfigsFor(shippedGamemode('pug'), ['MatchZy'])).toBeUndefined()
    expect(pluginConfigsFor(shippedGamemode('flying-scoutsman'), [])).toBeUndefined()
  })
})
