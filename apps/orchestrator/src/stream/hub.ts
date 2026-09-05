import type { Clock, Timer } from '@ezpug/core'
import type { GameserverEventOf, StreamCloseCode, StreamFrame } from '@ezpug/match-api'
import { STREAM_TICK_BATCH_MAX } from '@ezpug/match-api'
import type { Log } from '../log'

/**
 * **The stream hub** (decision 6, PRD-02 T3): one per process, the place
 * every frame for a match is published and every subscriber of that match
 * hears it. Subscribers are sockets (`upgrade.ts`) or in-process listeners
 * (a test, the conformance runner); the hub does not know which.
 *
 * Frames cross a **fan-out** on their way to subscribers: with the Redis
 * one (`fanout.ts`) every replica publishes to one channel and every replica
 * delivers to its own subscribers, so two orchestrators behind one door
 * would both stream every match — nothing runs two this round, but the seam
 * is where it would go. The local fan-out is the loopback, for tests.
 *
 * Best effort by contract: position ticks are batched per match and
 * flushed on the next clock tick (or at `STREAM_TICK_BATCH_MAX`), never
 * stored; a subscriber that is gone by the time a frame arrives is gone.
 * The `hello` is not the hub's — whoever subscribes says it, because only
 * they know the match's `seq` at that instant.
 */

/** What crosses the fan-out: a frame for a match, or the order to close its sockets. */
export type HubMessage =
  | { kind: 'frame'; matchId: string; frame: StreamFrame }
  | { kind: 'close'; matchId: string; code: StreamCloseCode }

export interface Fanout {
  publish: (message: HubMessage) => Promise<void>
  /** Every message published by any replica, this one included. Returns the unsubscribe. */
  subscribe: (listener: (message: HubMessage) => void) => Promise<() => void>
  close: () => Promise<void>
}

/** The loopback: what a test and a single process use. */
export function createLocalFanout(): Fanout {
  const listeners = new Set<(message: HubMessage) => void>()
  return {
    publish: message => {
      for (const listener of listeners) listener(message)
      return Promise.resolve()
    },
    subscribe: listener => {
      listeners.add(listener)
      return Promise.resolve(() => {
        listeners.delete(listener)
      })
    },
    close: () => {
      listeners.clear()
      return Promise.resolve()
    },
  }
}

export interface StreamSubscriber {
  send: (frame: StreamFrame) => void
  close: (code: StreamCloseCode) => void
}

export interface StreamHub {
  /** Attach a subscriber to a match. Returns the unsubscribe. */
  subscribe: (matchId: string, subscriber: StreamSubscriber) => () => void
  /** A durable frame: `event`, `command_result`, `presence`. Delivered through the fan-out. */
  publish: (matchId: string, frame: Exclude<StreamFrame, { type: 'tick' | 'hello' }>) => void
  /** One position tick; batched and flushed on the next clock tick. */
  tick: (matchId: string, tick: GameserverEventOf<'position_tick'>) => void
  /** Close every subscriber of a match with a code — the match ended. */
  closeMatch: (matchId: string, code: StreamCloseCode) => void
  /** Subscribers attached to this process, in all. */
  size: (matchId?: string) => number
  /** Open the fan-out. Idempotent. */
  start: () => Promise<void>
  /** Detach from the fan-out and close every subscriber. */
  close: () => Promise<void>
}

export interface StreamHubOptions {
  clock: Clock
  log: Log
  fanout?: Fanout
}

export function createStreamHub(options: StreamHubOptions): StreamHub {
  const { clock, log } = options
  const fanout = options.fanout ?? createLocalFanout()
  const subscribers = new Map<string, Set<StreamSubscriber>>()
  const pending = new Map<string, { ticks: GameserverEventOf<'position_tick'>[]; timer: Timer }>()
  let unsubscribe: (() => void) | undefined
  let starting: Promise<void> | undefined

  const deliver = (message: HubMessage): void => {
    const set = subscribers.get(message.matchId)
    if (!set) return
    for (const subscriber of set) {
      try {
        if (message.kind === 'frame') subscriber.send(message.frame)
        else {
          set.delete(subscriber)
          subscriber.close(message.code)
        }
      } catch (error) {
        log.error(`stream: a subscriber of ${message.matchId} threw`, error)
      }
    }
    if (message.kind === 'close') subscribers.delete(message.matchId)
  }

  const publish = (message: HubMessage): void => {
    void fanout.publish(message).catch((error: unknown) => {
      log.error(`stream: fan-out of ${message.kind} for ${message.matchId} failed`, error)
    })
  }

  const flushTicks = (matchId: string): void => {
    const batch = pending.get(matchId)
    if (!batch) return
    pending.delete(matchId)
    batch.timer.cancel()
    if (batch.ticks.length === 0) return
    publish({ kind: 'frame', matchId, frame: { type: 'tick', ticks: batch.ticks } })
  }

  return {
    subscribe(matchId, subscriber) {
      let set = subscribers.get(matchId)
      if (!set) {
        set = new Set()
        subscribers.set(matchId, set)
      }
      set.add(subscriber)
      return () => {
        const current = subscribers.get(matchId)
        current?.delete(subscriber)
        if (current?.size === 0) subscribers.delete(matchId)
      }
    },
    publish(matchId, frame) {
      publish({ kind: 'frame', matchId, frame })
    },
    tick(matchId, tick) {
      let batch = pending.get(matchId)
      if (!batch) {
        batch = { ticks: [], timer: clock.after(0, () => flushTicks(matchId)) }
        pending.set(matchId, batch)
      }
      batch.ticks.push(tick)
      if (batch.ticks.length >= STREAM_TICK_BATCH_MAX) flushTicks(matchId)
    },
    closeMatch(matchId, code) {
      flushTicks(matchId)
      publish({ kind: 'close', matchId, code })
    },
    size: matchId =>
      matchId === undefined
        ? [...subscribers.values()].reduce((sum, set) => sum + set.size, 0)
        : (subscribers.get(matchId)?.size ?? 0),
    start() {
      starting ??= fanout.subscribe(deliver).then(off => {
        unsubscribe = off
      })
      return starting
    },
    async close() {
      for (const [matchId, batch] of pending) {
        batch.timer.cancel()
        pending.delete(matchId)
      }
      unsubscribe?.()
      unsubscribe = undefined
      starting = undefined
      for (const [matchId, set] of subscribers) {
        for (const subscriber of set) {
          try {
            subscriber.close(1001 as StreamCloseCode)
          } catch (error) {
            log.error(`stream: closing a subscriber of ${matchId} threw`, error)
          }
        }
      }
      subscribers.clear()
      await fanout.close()
    },
  }
}
