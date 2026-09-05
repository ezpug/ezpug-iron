import { z } from 'zod'
import { gameSchema } from '../vocabulary/game'
import { kebabNameSchema } from '../vocabulary/naming'
import { clientMatchIdSchema, matchIdSchema, timestampSchema } from './common'
import { simStatusSchema } from './sim'

/**
 * **A match as the orchestrator sees it** — a server's life around one
 * request. The platform keeps its own match machine (people, results, rating);
 * this is the server-shaped half of the story, and its states are the
 * server's: where it is in being obtained, configured, played and let go.
 */

/**
 * The lifecycle, in order. `cancelled` is reachable from every non-terminal
 * state before `live`; `failed` from every non-terminal state; `recovering`
 * only from `live` (a server lost mid-match, decision 6's `match.recovering`)
 * and back to `live` or on to `failed`.
 */
export const MATCH_STATES = [
  /** Accepted, ledger row not yet written. */
  'pending',
  /** Asking providers for a server; a ledger row exists. */
  'allocating',
  /** The server is up; the plugin is receiving its assignment. */
  'configuring',
  /** Players may connect; `connect` is filled. */
  'ready',
  /** The gamemode reported going live. */
  'live',
  /** The server was lost mid-match; a restore is being attempted. */
  'recovering',
  /** Played to its end; the server is released. */
  'ended',
  /** Could not be obtained, configured or recovered. */
  'failed',
  /** Cancelled by the client before going live. */
  'cancelled',
] as const
export const matchStateSchema = z.enum(MATCH_STATES)
export type MatchState = z.infer<typeof matchStateSchema>

/** The states nothing follows. */
export const TERMINAL_MATCH_STATES = ['ended', 'failed', 'cancelled'] as const satisfies readonly [
  MatchState,
  ...MatchState[],
]

export function isTerminalMatchState(state: MatchState): boolean {
  return (TERMINAL_MATCH_STATES as readonly string[]).includes(state)
}

/**
 * How players reach the server — facts only, display strings are the client's
 * job. The password travels here because the client hands it to rostered
 * players; it never appears on a fleet row.
 */
export const serverConnectSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().max(65_535),
  password: z.string().optional(),
})
export type ServerConnect = z.infer<typeof serverConnectSchema>

/**
 * The GOTV relay, where the server runs one. `delaySeconds` is reported, never
 * defaulted: the number is stated out loud to spectators, so a guess here
 * becomes a lie on a page.
 */
export const serverTvSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().max(65_535),
  delaySeconds: z.number().int().nonnegative(),
})
export type ServerTv = z.infer<typeof serverTvSchema>

/**
 * Why a match reached a terminal state, machine-readable. A client branches
 * on `kind`; `detail` is for humans and logs.
 */
export const MATCH_ENDED_KINDS = [
  /** The gamemode reported its series over. */
  'completed',
  /** A `force_end` command. */
  'force_ended',
  /** A cancel before going live. */
  'cancelled',
  /** The request's `ttlMinutes` (or the key's ceiling) ran out; the reaper ended it. */
  'ttl_expired',
  /** The server was lost and could not be restored. */
  'server_lost',
  /** No provider could allocate. */
  'allocation_failed',
  /** The provider or node failed after allocation. */
  'provider_error',
] as const
export const matchEndedKindSchema = z.enum(MATCH_ENDED_KINDS)
export type MatchEndedKind = z.infer<typeof matchEndedKindSchema>

export const matchEndedReasonSchema = z.object({
  kind: matchEndedKindSchema,
  detail: z.string().optional(),
})
export type MatchEndedReason = z.infer<typeof matchEndedReasonSchema>

export const matchSchema = z.object({
  id: matchIdSchema,
  clientMatchId: clientMatchIdSchema,
  state: matchStateSchema,
  game: gameSchema,
  gamemode: kebabNameSchema,
  /** The provider the server came from — a badge (`dathost`, `sim`, a node's), null before allocation. */
  provider: kebabNameSchema.nullable(),
  /** The provider's own handle for the server; the `source.serverId` on every event. */
  serverId: z.string().min(1).nullable(),
  /** The fleet ledger row this match holds, null before allocation. */
  fleetServerId: z.uuid().nullable(),
  /** Filled from `ready` on. */
  connect: serverConnectSchema.nullable(),
  tv: serverTvSchema.nullable(),
  /** The last durable sequence number delivered for this match; `0` before the first. */
  seq: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  readyAt: timestampSchema.nullable(),
  liveAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  /** When the reaper will end it regardless — `createdAt` plus the effective ttl. */
  expiresAt: timestampSchema,
  endedReason: matchEndedReasonSchema.nullable(),
  /** Present on the `sim` provider only. */
  sim: simStatusSchema.nullable(),
})
export type Match = z.infer<typeof matchSchema>

/** The filter `GET /v1/matches` accepts on top of the page query. */
export const matchListFilterSchema = z.object({
  state: matchStateSchema.optional(),
  clientMatchId: clientMatchIdSchema.optional(),
})
export type MatchListFilter = z.infer<typeof matchListFilterSchema>
