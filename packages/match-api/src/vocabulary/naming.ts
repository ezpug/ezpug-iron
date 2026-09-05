import { z } from 'zod'

/**
 * The naming grammar — the platform's `naming.ts` on 2026-09-05, reduced to
 * the grammar this contract uses: kebab-case identifiers, snake_case event
 * types, `domain.event` fact names and route paths. The platform's channel,
 * job, stream and notification grammars stayed there; nothing on this wire
 * names one. The regexes are the platform's byte for byte, so an id that
 * parses on one side parses on the other.
 */

const KEBAB = String.raw`[a-z][a-z0-9]*(?:-[a-z0-9]+)*`
const SNAKE = String.raw`[a-z][a-z0-9]*(?:_[a-z0-9]+)*`

/**
 * kebab-case identifier: route segments, provider ids, gamemode ids, node
 * ids, regions, scopes.
 */
export const kebabNameSchema = z
  .string()
  .regex(new RegExp(`^${KEBAB}$`), 'expected kebab-case (e.g. `parse-demo`)')

/**
 * Domain event name: `domain.event`, both sides snake_case, exactly one dot,
 * event phrase in past tense (a fact, never a command) — `match.allocated`,
 * `demo.uploaded`. Past tense is reviewed, not machine-checked.
 */
export const domainEventNameSchema = z
  .string()
  .regex(
    new RegExp(`^${SNAKE}\\.${SNAKE}$`),
    'expected `domain.event` in snake_case, past tense (e.g. `match.round_ended`)',
  )

/**
 * API route path: absolute, kebab-case segments, `:camelCase` params —
 * `/v1/matches/:matchId`.
 */
const SEGMENT = String.raw`(?:${KEBAB}|:[a-z][a-zA-Z0-9]*)`
export const routePathSchema = z
  .string()
  .regex(
    new RegExp(`^/(?:${SEGMENT}(?:/${SEGMENT})*)?$`),
    'expected an absolute kebab-case path with `:camelCase` params (e.g. `/users/:userId`)',
  )

/** Names of the `:param` tokens in a route path, in order. */
export function routePathParams(path: string): string[] {
  return [...path.matchAll(/:([a-z][a-zA-Z0-9]*)/g)].map(m => m[1] ?? '')
}

/**
 * Normalized gameserver event type: snake_case, naming the server moment —
 * `round_end`, `player_death`, `going_live`. Not `domain.event` like a bus
 * fact: these are what a gameserver (or the simulator) *says*. The set is
 * closed — the union in `gameserver.ts` is the platform's Match.md §5
 * verbatim, and adapters translate provider vocabulary into it, never past it.
 */
export const gameserverEventTypeSchema = z
  .string()
  .regex(new RegExp(`^${SNAKE}$`), 'expected snake_case (e.g. `round_end`)')

/**
 * A snake_case word: player command names, cvar-free identifiers a plugin
 * reads. Same grammar as an event type, named for what it labels.
 */
export const snakeNameSchema = gameserverEventTypeSchema
