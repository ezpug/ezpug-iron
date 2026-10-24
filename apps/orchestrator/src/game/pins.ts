/**
 * **What the server stack pins, as the orchestrator knows it** (PRD-10 T2).
 * The homes a build reads are `docker/cs2/Dockerfile`'s `ARG`s and
 * `plugins/Directory.Build.props`; this is the copy the running orchestrator
 * carries, so a `game.build_moved` fact can say what the stack was pinned to
 * at the moment the game moved and the watcher can tell a release that is
 * newer than what we ship from one that is not. `scripts/check-pins.mjs`
 * holds every value here equal to its home, so a bump that forgets this file
 * is a red `pnpm lint`, and `pnpm game:follow` (T5) rewrites it with the rest.
 *
 * The keys are opaque to every consumer: a fact carries them as
 * `Record<string, string>`, and the platform never reads them by name.
 */
export const GAME_PINS = {
  counterStrikeSharp: '1.0.378',
  metamod: '2.0.0-git1483',
  multiAddonManager: '1.7.1',
  matchzy: '1.4.32-ezpug.1',
} as const

export type GamePinKey = keyof typeof GAME_PINS

/**
 * **The upstreams the watcher follows**, one per pin: where a release is
 * announced, and how its version is read. GitHub's releases API for three
 * of them; Metamod:Source publishes no releases and is read off its drop's
 * `latest` pointer, which answers the file name of the newest build.
 */
export interface GameUpstreamSource {
  readonly pin: GamePinKey
  /** `owner/repo`, the name a fact and the route carry. */
  readonly repo: string
  readonly kind: 'github-release' | 'metamod-drop'
}

export const GAME_UPSTREAMS: readonly GameUpstreamSource[] = [
  { pin: 'counterStrikeSharp', repo: 'roflmuffin/CounterStrikeSharp', kind: 'github-release' },
  { pin: 'metamod', repo: 'alliedmodders/metamod-source', kind: 'metamod-drop' },
  { pin: 'multiAddonManager', repo: 'Source2ZE/MultiAddonManager', kind: 'github-release' },
  { pin: 'matchzy', repo: 'ezpug/MatchZy-Enhanced', kind: 'github-release' },
]
