import { z } from 'zod'
import { steamId64Schema } from '../vocabulary/steam-id'
import { matchIdSchema, timestampSchema } from './common'

/**
 * **A player's key to one match** (decision 17). A gamemode widget opens its
 * own socket to the orchestrator with this token; taps become player-scoped
 * commands relayed to the plugin. Scoped to one match and one SteamID64,
 * short-lived, minted by the client (which knows who is looking at the page)
 * and never by the widget. Shown once, never logged.
 */

/** How long a token lives when the client does not say: fifteen minutes. */
export const PLAYER_TOKEN_TTL_SECONDS_DEFAULT = 15 * 60
/** The longest a player token may live. */
export const PLAYER_TOKEN_TTL_SECONDS_MAX = 60 * 60

export const playerTokenRequestSchema = z.object({
  steamId64: steamId64Schema,
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(PLAYER_TOKEN_TTL_SECONDS_MAX)
    .default(PLAYER_TOKEN_TTL_SECONDS_DEFAULT),
})
export type PlayerTokenRequest = z.infer<typeof playerTokenRequestSchema>

export const playerTokenSchema = z.object({
  /** The bearer token. Opaque; hand it to the widget and forget it. */
  token: z.string().min(16),
  matchId: matchIdSchema,
  steamId64: steamId64Schema,
  expiresAt: timestampSchema,
})
export type PlayerToken = z.infer<typeof playerTokenSchema>
