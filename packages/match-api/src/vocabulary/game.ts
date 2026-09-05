import { z } from 'zod'

/**
 * The game dimension (decision 18). `game ∈ {cs2, csgo}` flows through the
 * match request, the gamemode manifest and capability matching: a CS:GO match
 * only considers `csgo`-capable servers, and no provider advertises one this
 * round, so a `csgo` request gets a clean `no_capable_server` refusal instead
 * of a special-cased pipeline. The platform's `game.ts`, verbatim.
 */
export const GAMES = ['cs2', 'csgo'] as const

export const gameSchema = z.enum(GAMES)
export type Game = z.infer<typeof gameSchema>
