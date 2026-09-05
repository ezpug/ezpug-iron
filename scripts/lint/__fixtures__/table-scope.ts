// Two known table-scope violations: a whole-table read and a whole-table count
// both assert about rows other suites committed to the shared test database.

interface Query {
  select: (columns?: unknown) => Query
  from: (table: unknown) => Query
  where: (condition: unknown) => Query
}

declare const tx: Query
declare const users: unknown
declare const count: unknown
declare const mine: unknown

export function readsEverybodysRows(): Query {
  return tx.select().from(users)
}

export function countsEverybodysRows(): Query {
  return tx.select({ count }).from(users)
}

/** Scoped to the ids this test owns — the shape the guard asks for. */
export function readsItsOwnRows(): Query {
  return tx.select().from(users).where(mine)
}
