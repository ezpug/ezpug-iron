import type { WebhookEnvelope } from './envelope'

/**
 * **The consumer's dedupe, keyed the way the envelope is identified.** A
 * webhook consumer will see the same thing twice, and there are two different
 * twices:
 *
 * - **The same delivery again** — a retry, because the first answer was slow,
 *   lost or a `500` after the handler had already run. Same `deliveryId`.
 * - **The same fact again** — the stream's `event` frame carries the envelope
 *   the webhook carries, and a replay from `GET /v1/matches/:matchId/events`
 *   carries it a third time. Same `(matchId, seq)`, and — for the stream and
 *   the replay — the same `deliveryId` too, but a consumer must not depend on
 *   that: `(matchId, seq)` is what names the fact.
 *
 * So both keys are recorded and both are checked, which is what lets one
 * deduper sit in front of all three paths and lets a consumer subscribe to
 * the stream, take webhooks and replay a gap without writing anything twice.
 *
 * The store is the caller's: a `Map` for a test ({@link createMemoryDeliveryStore}),
 * Redis with a TTL past the retry schedule's sixteen hours, or a unique index
 * on the consumer's own table. Nothing here is a wall clock: expiry is the
 * store's business, and the store is the only place that knows how long the
 * consumer keeps history.
 */

/** Where seen keys live. Sync or async, so a `Map` and a Redis client both fit. */
export interface DeliveryDeduperStore {
  has: (key: string) => boolean | Promise<boolean>
  add: (key: string) => void | Promise<void>
}

/** Which of the two identities had already been seen. */
export type DeliveryDuplicate = 'duplicate_delivery' | 'duplicate_fact'

export interface DeliveryDeduper {
  /**
   * Record the envelope and say whether it is new: `null` means "handle it",
   * anything else means "you already have this, answer `2xx` and stop".
   * Recording happens on the way through, so two concurrent deliveries of one
   * fact race in the store rather than in the handler.
   */
  check: (envelope: WebhookEnvelope) => Promise<DeliveryDuplicate | null>
  /** The two keys an envelope is recorded under — for a consumer writing its own store. */
  keys: (envelope: WebhookEnvelope) => { delivery: string; fact: string }
}

/** The key a retry collides on. */
export function deliveryKey(deliveryId: string): string {
  return `delivery:${deliveryId}`
}

/** The key the stream, the webhook and the replay of one fact all collide on. */
export function factKey(matchId: string, seq: number): string {
  return `fact:${matchId}:${seq}`
}

export function createDeliveryDeduper(store: DeliveryDeduperStore): DeliveryDeduper {
  const keys = (envelope: WebhookEnvelope) => ({
    delivery: deliveryKey(envelope.deliveryId),
    fact: factKey(envelope.matchId, envelope.seq),
  })
  return {
    keys,
    check: async envelope => {
      const { delivery, fact } = keys(envelope)
      if (await store.has(delivery)) return 'duplicate_delivery'
      if (await store.has(fact)) {
        // A second delivery id for a fact already handled: record the id too,
        // so its own retries are cheap.
        await store.add(delivery)
        return 'duplicate_fact'
      }
      await store.add(delivery)
      await store.add(fact)
      return null
    },
  }
}

export interface MemoryDeliveryStoreOptions {
  /**
   * How many keys to keep before the oldest are dropped. A consumer that
   * relies on this in production has the wrong store; it is a test's bound
   * against an unbounded set. Default 10 000.
   */
  max?: number
}

/** An in-memory store — what a test and a single-process consumer use. */
export function createMemoryDeliveryStore(
  options: MemoryDeliveryStoreOptions = {},
): DeliveryDeduperStore & { size: () => number } {
  const max = options.max ?? 10_000
  const seen = new Set<string>()
  return {
    has: key => seen.has(key),
    add: key => {
      seen.add(key)
      while (seen.size > max) {
        const oldest = seen.values().next()
        if (oldest.done) break
        seen.delete(oldest.value)
      }
    },
    size: () => seen.size,
  }
}
