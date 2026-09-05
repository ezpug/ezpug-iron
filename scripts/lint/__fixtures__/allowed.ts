// The other side of the guard: none of this may be flagged.

export const parsed = new Date('2026-01-01T00:00:00Z')
export const copied = new Date(parsed.getTime())

// biome-ignore lint/plugin: the self-test proves the escape hatch still works
export const escaped = Date.now()

// biome-ignore lint/plugin: the self-test proves the isolation escape hatch works
export const wiped = (client: { flushdb: () => Promise<unknown> }) => client.flushdb()
