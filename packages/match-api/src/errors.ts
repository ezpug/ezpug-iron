import { z } from 'zod'

/**
 * **The error shape, decided once.** Every non-2xx JSON response the
 * orchestrator (and the fake) sends is `{ error: { code, message, details? } }`:
 * `code` from the closed set below, `message` for a human reading a log,
 * `details` for whatever the code needs to say precisely (the field a
 * validation failed on, the budget line that was exceeded). A client branches
 * on `code` and never on prose.
 *
 * The HTTP status per code is part of the contract ({@link MATCH_API_ERROR_STATUS}):
 * the conformance suite asserts it against the fake and the real orchestrator,
 * and the client's retry policy (which retries `5xx` and `429`, never a `402`)
 * is derived from it rather than guessed.
 */
export const MATCH_API_ERROR_CODES = [
  /** No API key, or one that is unknown or revoked. */
  'unauthorized',
  /** The key exists but lacks the route's scope. */
  'forbidden',
  /** The match, server, node or key does not exist for this key. */
  'not_found',
  /** The body, params or query did not parse. `details.issues` lists why. */
  'validation_failed',
  /** `clientMatchId` was seen before with a different body, or a key name is taken. */
  'conflict',
  /** The command or transition is not legal in the match's current state. */
  'invalid_state',
  /** The server or gamemode cannot honour this command (`sim.*` off a sim, `rcon` on one). */
  'command_unsupported',
  /** A `restore` with no backup to restore from. */
  'no_backup',
  /** The player is not on the roster and the gamemode is not open-join. */
  'player_not_in_match',
  /** No gamemode of that id in the catalog. */
  'unknown_gamemode',
  /** The gamemode does not play the requested `game`. */
  'game_unsupported',
  /** No provider can host the request right now — or ever, for `csgo` this round. */
  'no_capable_server',
  /** The key's concurrent, lifetime or monthly ceiling would be crossed (decision 7). */
  'budget_exceeded',
  /** Too many requests; the client backs off. */
  'rate_limited',
  /** The provider or node behind this server is not answering. */
  'provider_unavailable',
  /** The orchestrator's own fault. Retryable. */
  'internal',
] as const
export const matchApiErrorCodeSchema = z.enum(MATCH_API_ERROR_CODES)
export type MatchApiErrorCode = z.infer<typeof matchApiErrorCodeSchema>

/** The HTTP status each code travels with. One writer, so the two never drift. */
export const MATCH_API_ERROR_STATUS: Readonly<Record<MatchApiErrorCode, number>> = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  invalid_state: 409,
  command_unsupported: 400,
  no_backup: 409,
  player_not_in_match: 422,
  unknown_gamemode: 422,
  game_unsupported: 422,
  no_capable_server: 503,
  budget_exceeded: 402,
  rate_limited: 429,
  provider_unavailable: 503,
  internal: 500,
})

export const matchApiErrorSchema = z.object({
  code: matchApiErrorCodeSchema,
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type MatchApiError = z.infer<typeof matchApiErrorSchema>

/** Every non-2xx JSON response has this shape. */
export const errorEnvelopeSchema = z.object({
  error: matchApiErrorSchema,
})
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>

/**
 * What the client throws. `code` is the closed set plus `unknown_error` for a
 * response that was not an envelope at all (a proxy's HTML 502, a truncated
 * body) — the status is still there to decide a retry on.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  constructor(
    readonly status: number,
    readonly code: MatchApiErrorCode | 'unknown_error',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}
