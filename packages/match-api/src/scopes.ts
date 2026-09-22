import { z } from 'zod'

/**
 * **What an API key may do** (decision 7, 12). Three route scopes, one per
 * audience, and one body scope:
 *
 * - `matches` — the platform's match pipeline: create, read, command and
 *   cancel matches, mint player tokens, read the gamemode catalog and capacity.
 * - `fleet` — the operator console: the ledger, providers, nodes, budgets, the
 *   GSLT pool, console and RCON on a server. Reads *and* drains — a fleet key
 *   can take capacity away, never create a match.
 * - `admin` — keys themselves: mint, list, revoke, edit scopes, set budgets
 *   and webhook secrets. `admin` implies the other three
 *   ({@link scopeAllows}), so the one admin key an operator holds is not also
 *   four keys to rotate.
 * - `simulation` — **puppets** (PRD-03 T4): a match request may carry a
 *   `simulation` block, and the server plays it with simulated players in
 *   the roster's seats. No route requires it; `POST /v1/matches` still needs
 *   `matches`, and this one is checked against the *body*
 *   ({@link matchRequestScopes}) — a request that carries the block on a key
 *   without the scope is `forbidden`, with `details.scope` naming it.
 *
 *   **Production's platform key holds it** (owner call, 2026-09-21). This
 *   comment used to say it never would, and the rule was meant to keep a real
 *   match from becoming a simulated one by accident. The owner pressed the
 *   admin console's "test match with puppets" against production and got
 *   `forbidden`; the button is the point of the fleet door. What actually
 *   keeps the two apart is narrower and already true: the block is never
 *   implied, so a request becomes a rehearsal only by carrying
 *   `simulation` explicitly, and every fact of such a match says
 *   `source.simulated`. The scope is the door on *who may ask*, and the
 *   platform's own `puppets` flag is what decides whether a match counts.
 *   Moving it on a live key is `PATCH /v1/keys/:keyId/scopes` (PRD-04 T3),
 *   not an `UPDATE`.
 *
 * Every route declares exactly one required scope (`rpc.ts`'s `defineRoute`
 * refuses one without), and the orchestrator decides from the declaration —
 * there is no second table.
 */
export const MATCH_API_SCOPES = ['matches', 'fleet', 'admin', 'simulation'] as const
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

/**
 * **The scopes a match request's body needs on top of the route's** — today
 * `simulation` when the request carries a `simulation` block, and nothing
 * otherwise. Decided here so the orchestrator and the fake refuse the same
 * bodies with the same `forbidden`, in the same order: body scopes are
 * checked before anything about the request is validated, because an
 * unauthorised request is not owed a diagnosis.
 */
export function matchRequestScopes(request: { simulation?: unknown }): MatchApiScope[] {
  return request.simulation === undefined ? [] : ['simulation']
}
