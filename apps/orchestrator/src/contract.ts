import { ApiError, MATCH_API_ERROR_STATUS } from '@ezpug/match-api'
import type { ZodType } from 'zod'

/**
 * **A service is a door too** (PRD-03 T9b).
 *
 * `http/dispatch.ts` parses every request body against the route's schema and
 * every answer against the route's response, so nothing off the contract
 * reaches a handler and nothing off the contract reaches a client. But a
 * service is not only called by its route: the bootstrap key adopts itself at
 * boot, a node is enrolled by a test rig, the conformance target mints its own
 * keys in-process. Those callers hold the contract's *TypeScript* type, which
 * knows `string` and not `max(64)` — so a refinement the wire enforces is
 * nobody's job in the process.
 *
 * On 2026-09-20 that cost a database: `keys.mint` took names of 71 characters
 * from an earlier `verify:extended`, wrote them, and `GET /v1/keys` then
 * answered `internal` **for every caller of that database**, because the
 * response no longer parsed. A row a service writes is forever; a refusal is
 * one call. So the schema is read at the write, not only at the door, and a
 * value the Match API cannot carry is `validation_failed` wherever it came
 * from.
 *
 * This is deliberately the *contract's* schema and never a second opinion
 * about it (decision 19: nothing here double-speaks) — a field that grows a
 * bound in `@ezpug/match-api` grows it here on the next install.
 */
export function onContract<T>(schema: ZodType<T>, value: unknown, subject: string): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new ApiError(
    MATCH_API_ERROR_STATUS.validation_failed,
    'validation_failed',
    `${subject} is not something the Match API can carry`,
    { issues: parsed.error.issues },
  )
}
