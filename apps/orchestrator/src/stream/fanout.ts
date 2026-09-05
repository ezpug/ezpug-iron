import { Redis } from 'ioredis'
import type { RedisConfig } from '../config'
import type { Log } from '../log'
import type { Fanout, HubMessage } from './hub'

/**
 * **The Redis fan-out** behind the stream hub: one channel, every replica
 * publishes to it and every replica delivers what it hears to its own
 * subscribers. Two connections, because a Redis client in subscriber mode
 * cannot issue commands; both are opened by `start()` and closed by the
 * drain step that owns the hub (`shutdown-steps.ts`).
 *
 * A message that does not parse (a newer replica's frame this one does not
 * know) is logged and dropped, never thrown: the stream is best effort and
 * the events route has the fact.
 */
export const STREAM_CHANNEL = 'ezpug-iron:stream'

export function createRedisFanout(options: { config: RedisConfig; log: Log }): Fanout {
  const { config, log } = options
  const make = (name: string): Redis => {
    const client = new Redis(config.url, {
      connectionName: name,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 2_000,
    })
    client.on('error', () => {})
    return client
  }
  const publisher = make('orchestrator-stream-pub')
  const subscriber = make('orchestrator-stream-sub')

  return {
    async publish(message) {
      if (publisher.status === 'wait') await publisher.connect()
      await publisher.publish(STREAM_CHANNEL, JSON.stringify(message))
    },
    async subscribe(listener) {
      if (subscriber.status === 'wait') await subscriber.connect()
      const onMessage = (channel: string, raw: string): void => {
        if (channel !== STREAM_CHANNEL) return
        try {
          listener(JSON.parse(raw) as HubMessage)
        } catch (error) {
          log.error('stream: a fan-out message did not parse', error)
        }
      }
      subscriber.on('message', onMessage)
      await subscriber.subscribe(STREAM_CHANNEL)
      return () => {
        subscriber.off('message', onMessage)
      }
    },
    async close() {
      for (const client of [subscriber, publisher]) {
        if (client.status === 'end' || client.status === 'wait') {
          client.disconnect()
          continue
        }
        try {
          await client.quit()
        } catch {
          client.disconnect()
        }
      }
    },
  }
}
