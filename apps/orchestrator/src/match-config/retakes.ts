import type { GamemodeManifest } from '@ezpug/match-api'

/**
 * **cs2-retakes' own config file** (PRD-02 T23): the JSON
 * CounterStrikeSharp hands `RetakesPlugin` at load, built from the manifest
 * and nothing else. Pure, golden-tested, and the twin of
 * `match-config/matchzy.ts` one plugin over — a vendored plugin whose
 * settings are not cvars gets a document instead, and the assignment carries
 * it as `pluginConfigs.RetakesPlugin` for the loader to write where the
 * plugin will look (`configs/plugins/RetakesPlugin/RetakesPlugin.json`).
 *
 * **It is deliberately partial.** CounterStrikeSharp deserialises the file
 * into `BaseConfigs`, whose every property carries upstream's own default, so
 * a key this builder does not write is a key that keeps the value the plugin
 * shipped with. Four are written, and each is a decision EZPug is entitled to
 * make about somebody else's plugin; everything about how a retake *plays* —
 * the team ratio, the scramble, the bomb, the announcements — stays exactly
 * as B3none set it.
 *
 * The shape is `plugins/vendor/cs2-retakes/RetakesPlugin/Configs/BaseConfigs.cs`.
 */

/** The plugin folder this config belongs to — the manifest's `plugins` entry, and the file's own name. */
export const RETAKES_PLUGIN = 'RetakesPlugin'

/** The plugin folder of the weapon allocator that runs beside it (`docs/pins.md`). */
export const RETAKES_ALLOCATOR_PLUGIN = 'RetakesAllocator'

/** cs2-retakes clamps `MaxPlayers` to this range: below it a retake cannot be played, above it the shipped spawn configs run out. */
export const MAX_PLAYERS_RANGE = { min: 2, max: 10 } as const

/** What this builder writes; every other section of `BaseConfigs` is left to upstream's defaults. */
export interface RetakesPluginConfig {
  GameSettings: {
    MaxPlayers: number
    EnableFallbackAllocation: boolean
  }
  QueueSettings: {
    ShouldAutoJoinGame: boolean
    QueuePriorityFlag: never[]
    QueueImmunityFlag: never[]
  }
}

export interface RetakesConfigInput {
  manifest: GamemodeManifest
  /** The plugin folders the assignment enables — the allocator is only switched on when the image has it. */
  plugins: readonly string[]
}

export function buildRetakesConfig({ manifest, plugins }: RetakesConfigInput): RetakesPluginConfig {
  const { min, max } = MAX_PLAYERS_RANGE
  return {
    GameSettings: {
      // **The manifest's slots, not a number in a file.** `teamSize × teams`
      // is what the platform shows a player when it offers the mode, so it is
      // what decides how many the plugin lets onto the server; a manifest that
      // asked for more than the shipped spawns hold is clamped rather than
      // refused, because the plugin would clamp it anyway and silently.
      MaxPlayers: Math.min(Math.max(manifest.slots.teamSize * manifest.slots.teams, min), max),
      // The vendored allocator allocates (`docs/pins.md`); two of them
      // allocating the same round is upstream's own documented mistake. When
      // the image has no allocator the plugin's fallback stays on, so a server
      // that lost it still hands out guns.
      EnableFallbackAllocation: !plugins.includes(RETAKES_ALLOCATOR_PLUGIN),
    },
    QueueSettings: {
      // **Open join is the mode** (`slots.openJoin`): a retake has no sides to
      // pick, and a team menu in front of a player who tapped "play" is a
      // menu nobody asked for. Straight in during warmup, into the queue
      // after — the plugin's own words.
      ShouldAutoJoinGame: manifest.slots.openJoin,
      // **No second permission mechanism** (the round's hard don'ts): upstream
      // defaults both of these to a `@css/vip` entry, which would make a
      // CounterStrikeSharp admin file decide who keeps a slot when the server
      // is full. EZPug has one permission mechanism and it is API-key scopes,
      // so the queue is first come, first served.
      QueuePriorityFlag: [],
      QueueImmunityFlag: [],
    },
  }
}

/**
 * The `pluginConfigs` map for an assignment, or `undefined` when nothing it
 * enables is configured by file. Keyed by plugin folder, because the file
 * belongs to the plugin and not to the mode: the next entry (the WeaponPaints
 * fork, T28) joins it here without anything else changing.
 */
export function pluginConfigsFor(
  manifest: GamemodeManifest,
  plugins: readonly string[],
): Record<string, Record<string, unknown>> | undefined {
  if (!plugins.includes(RETAKES_PLUGIN)) return undefined
  return {
    [RETAKES_PLUGIN]: buildRetakesConfig({ manifest, plugins }) as unknown as Record<
      string,
      unknown
    >,
  }
}
