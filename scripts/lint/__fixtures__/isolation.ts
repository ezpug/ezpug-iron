// Two known test-isolation violations: `flushdb` and `flushall` wipe a whole
// logical database that other suites are using at the same time.

interface FlushableClient {
  flushdb: () => Promise<unknown>
  flushall: () => Promise<unknown>
}

export async function wipe(client: FlushableClient): Promise<void> {
  await client.flushdb()
  await client.flushall()
}
