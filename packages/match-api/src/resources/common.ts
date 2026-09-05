import { z } from 'zod'

/**
 * The small shapes every resource shares. Timestamps are ISO-8601 strings in
 * UTC, stamped by the orchestrator's injected clock (never a server's clock —
 * the vocabulary's events carry no wall time for exactly that reason).
 */

/** An ISO-8601 instant, always with an offset (`2026-09-05T18:30:00.000Z`). */
export const timestampSchema = z.iso.datetime({ offset: true })
export type Timestamp = z.infer<typeof timestampSchema>

/** A match's id — minted by the orchestrator, a uuid. */
export const matchIdSchema = z.uuid()

/**
 * The client's own id for a match: the platform's match uuid in practice, any
 * stable string in the contract. The idempotency key of `POST /v1/matches` —
 * a retried create with the same `clientMatchId` returns the same match, one
 * with a different body is a `conflict`.
 */
export const clientMatchIdSchema = z.string().min(1).max(128)

/**
 * An opaque cursor for a paged list. A client passes back exactly what it was
 * handed; the shape inside is the server's business and may change without a
 * release.
 */
export const cursorSchema = z.string().min(1).max(512)

/** How many rows one page may carry. */
export const PAGE_LIMIT_MAX = 200
export const PAGE_LIMIT_DEFAULT = 50

/** The query every paged list accepts. */
export const pageQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().positive().max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
})
export type PageQuery = z.infer<typeof pageQuerySchema>

/** A page of `item`s and the cursor for the next one, or null at the end. */
export function pageSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    nextCursor: cursorSchema.nullable(),
  })
}
