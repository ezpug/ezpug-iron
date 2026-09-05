import { z } from 'zod'

/**
 * **What an API key may do** (decision 7, 12). Three scopes, one per audience:
 *
 * - `matches` — the platform's match pipeline: create, read, command and
 *   cancel matches, mint player tokens, read the gamemode catalog and capacity.
 * - `fleet` — the operator console: the ledger, providers, nodes, budgets, the
 *   GSLT pool, console and RCON on a server. Reads *and* drains — a fleet key
 *   can take capacity away, never create a match.
 * - `admin` — keys themselves: mint, list, revoke, set budgets and webhook
 *   secrets. `admin` implies the other two ({@link scopeAllows}), so the one
 *   admin key an operator holds is not also three keys to rotate.
 *
 * Every route declares exactly one required scope (`rpc.ts`'s `defineRoute`
 * refuses one without), and the orchestrator decides from the declaration —
 * there is no second table.
 */
export const MATCH_API_SCOPES = ['matches', 'fleet', 'admin'] as const
export const matchApiScopeSchema = z.enum(MATCH_API_SCOPES)
export type MatchApiScope = z.infer<typeof matchApiScopeSchema>

/** The scopes a key holds — a set, no duplicates, any order. */
export const matchApiScopesSchema = z
  .array(matchApiScopeSchema)
  .min(1)
  .refine(scopes => new Set(scopes).size === scopes.length, 'a scope is listed twice')

/** True when a key holding `held` may call a route that requires `required`. */
export function scopeAllows(held: readonly MatchApiScope[], required: MatchApiScope): boolean {
  return held.includes('admin') || held.includes(required)
}
