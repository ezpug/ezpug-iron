// Two known shared-setting violations: the store composed into a test, and
// the row written straight through drizzle. Both hold a lock on the one row
// per key the whole workspace shares, for as long as the test's transaction
// stays open.

interface Query {
  insert: (table: unknown) => Query
  values: (row: unknown) => Query
}

declare const tx: Query
declare const platformSettings: unknown
declare const clock: unknown
declare function createPlatformSettings(options: unknown): unknown
declare function createTestPlatformSettings(): unknown

export function composesTheRealStore(): unknown {
  return createPlatformSettings({ clock })
}

export function writesTheSharedRow(): Query {
  return tx.insert(platformSettings).values({ key: 'drop_rate' })
}

/** The door: in memory, nobody blocked — the shape the guard asks for. */
export function composesTheTestStore(): unknown {
  return createTestPlatformSettings()
}
