import { z } from 'zod'
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '../resources/common'
import { webhookEnvelopeSchema } from './envelope'

/**
 * **The replay** (decision 6): `GET /v1/matches/:matchId/events` answers the
 * same envelopes the webhooks carried, in `seq` order, from a cursor on.
 * This is the one paged route whose cursor is not opaque: it is the `seq`
 * to resume after, as a decimal string, because everything a consumer
 * holds is a `seq` — `Match.seq`, the stream's `hello.seq`, the last
 * envelope it stored — and none of those is a cursor it was handed.
 *
 * `nextCursor` is the last `seq` on the page, or null when the page ran to
 * the match's end *and* the match is terminal — a live match never says
 * null, because more is coming; a consumer polls with the cursor it holds.
 */

/** A cursor is a `seq` (or `0`) as digits. */
export const eventsCursorSchema = z.string().regex(/^(0|[1-9]\d*)$/, 'expected a seq as digits')

export const eventsQuerySchema = z.object({
  /** The `seq` to resume after; `"0"` is everything. */
  cursor: eventsCursorSchema.default('0'),
  limit: z.coerce.number().int().positive().max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
})
export type EventsQuery = z.infer<typeof eventsQuerySchema>

export const eventsPageSchema = z.object({
  items: z.array(webhookEnvelopeSchema),
  nextCursor: eventsCursorSchema.nullable(),
})
export type EventsPage = z.infer<typeof eventsPageSchema>

/** The cursor that resumes after `seq`. */
export function eventsCursor(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) throw new RangeError('a seq is a non-negative integer')
  return String(seq)
}

/** The `seq` a cursor resumes after. */
export function parseEventsCursor(cursor: string): number {
  return Number(eventsCursorSchema.parse(cursor))
}
