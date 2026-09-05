/**
 * The shared column vocabulary — decided once so no two tables disagree about
 * how an id or a timestamp looks. The platform's `packages/db/src/columns.ts`,
 * ported with its two rules:
 *
 * - **Ids come from the application, not the database.** No `gen_random_uuid()`
 *   default: a seeded world must produce the same ids twice, so writers pass an
 *   id from `Prng.uuid()` (fixtures, the sim) or `crypto.randomUUID()`.
 * - **Timestamps are `timestamptz`, always, and carry a JS `Date`.** No
 *   `defaultNow()` on anything logic depends on — the value comes from the
 *   injected `Clock` (`clock.date()`), per the determinism invariant.
 */
import { timestamp, uuid } from 'drizzle-orm/pg-core'

/** Primary key: uuid, supplied by the writer (see the determinism rule above). */
export function uuidPk(name = 'id') {
  return uuid(name).primaryKey()
}

/** A timezone-aware timestamp mapped to a JS `Date`. */
export function timestamptz(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' })
}

/** `created_at timestamptz not null` — the writer passes `clock.date()`. */
export function createdAt(name = 'created_at') {
  return timestamptz(name).notNull()
}

/** `updated_at timestamptz not null` — same rule; bump it on every write. */
export function updatedAt(name = 'updated_at') {
  return timestamptz(name).notNull()
}
