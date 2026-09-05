import { Redis } from 'ioredis'
import type { RedisConfig } from './config'
import { redactUrl } from './config'

/**
 * **The Redis connection**: one client per purpose, opened explicitly and
 * closed on shutdown, never an ambient singleton. This task opens the one
 * the health check pings; the stream hub's fan-out (T3) opens its own pair
 * (a subscriber connection cannot also issue commands), and each is a line
 * in `shutdown-steps.ts`.
 */
export interface RedisHandle {
  readonly client: Redis
  readonly config: RedisConfig
  /** One `PING`; throws with a redacted URL when the server is unreachable. */
  ping: () => Promise<void>
  close: () => Promise<void>
}

export function createRedis(config: RedisConfig, options: { name?: string } = {}): RedisHandle {
  const client = new Redis(config.url, {
    connectionName: options.name ?? 'ezpug-iron',
    // Connect on first use, not at construction: `createRedis` is called at
    // boot before the drain is armed, and a connection that fails then
    // should surface as a health check, not an unhandled event.
    lazyConnect: true,
    // A command that cannot be sent fails fast instead of queueing for a
    // server that may never come back; the health check is what says so.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 2_000,
  })
  // ioredis emits `error` on every failed reconnect; without a listener that
  // is an unhandled event that kills the process. The health check reports
  // the state; this only keeps the process alive to report it.
  client.on('error', () => {})

  return {
    client,
    config,
    async ping() {
      try {
        if (client.status === 'wait') await client.connect()
        await client.ping()
      } catch (error) {
        throw new Error(
          `cannot reach ${config.source}=${redactUrl(config.url)}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    },
    async close() {
      if (client.status === 'end') return
      try {
        await client.quit()
      } catch {
        client.disconnect()
      }
    },
  }
}
