import { z } from 'zod'

/**
 * **Which game the engine plays** (PRD-03 T3b, owner decision 2026-09-19), as
 * against the round format a match's rules spell out.
 *
 * - `competitive` is CS2's `game_mode 1`: the five-a-side game, played at
 *   whatever size the roster actually holds. **A 1v1 is this**, not a format
 *   of its own — one player a side, short rules, and the ready gate the
 *   roster derives (PRD-03 T1). Nothing in the engine has to change for it.
 * - `wingman` is CS2's `game_mode 2`: the two-a-side game, with its own live
 *   config (MR8 and a smaller overtime, where a request's rules say nothing
 *   else) and its own map layouts. The server loads the map again when it is
 *   not already in that mode, so a wingman match costs one map change at the
 *   start.
 *
 * **Maps are still the client's to name.** This API keeps no separate wingman
 * catalog and never substitutes a map: `maps[].map` is loaded as asked, under
 * the format's engine mode. Valve's competitive maps that ship a wingman
 * layout play it (the short half of the map, one bomb site); one that ships
 * none loads whole, which is legal and playable but is not the game a wingman
 * player expects — name a wingman map (`de_lake`, `de_shortdust`, …) when that
 * is what you mean.
 *
 * A gamemode says which of these it can play (`GamemodeManifest.formats`), so
 * a client can offer the format where it exists and the door can refuse it
 * where it does not.
 */
export const MATCH_FORMATS = ['competitive', 'wingman'] as const
export const matchFormatSchema = z.enum(MATCH_FORMATS)
export type MatchFormat = z.infer<typeof matchFormatSchema>

/**
 * **Wingman is two a side, and that is the format's meaning, not a house
 * rule.** The engine's wingman layouts hold two spawns per team; a request
 * that rosters a third player for a side is refused `validation_failed`
 * rather than sent to a server that cannot seat them.
 */
export const WINGMAN_TEAM_SIZE = 2

/**
 * **The engine's own game, as the server read it** (PRD-05 T2d,
 * ezpug/ezpug-iron#4): the `game_type` and `game_mode` convars when the map
 * loaded. That is when they take effect, because the engine reads them at
 * level init. A change after that decides the next map, which is why MatchZy
 * loads the map again when it switches a server to wingman. So these are the
 * numbers the map is being played under, not a request relayed back.
 */
export const engineGameSchema = z.object({
  gameType: z.number().int().nonnegative(),
  gameMode: z.number().int().nonnegative(),
})
export type EngineGame = z.infer<typeof engineGameSchema>

/**
 * The format an engine game is, or `undefined` for one that is neither:
 * `game_type 0` with `game_mode 1` is `competitive`, with `game_mode 2` it is
 * `wingman`, the same test MatchZy's `IsWingmanMode` makes. Deathmatch
 * (`1`/`2`), casual (`0`/`0`) and the rest have no format here.
 */
export function formatOfEngineGame(engine: EngineGame): MatchFormat | undefined {
  if (engine.gameType !== 0) return undefined
  if (engine.gameMode === 1) return 'competitive'
  if (engine.gameMode === 2) return 'wingman'
  return undefined
}
