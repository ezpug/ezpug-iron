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
