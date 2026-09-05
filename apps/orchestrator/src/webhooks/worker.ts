import type { Clock, Timer } from '@ezpug/core'
import {
  signWebhook,
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_ATTEMPT_TIMEOUT_MS,
  WEBHOOK_CONTENT_TYPE,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  webhookAttemptOutcome,
  webhookRetryDelayMs,
} from '@ezpug/match-api'
import type { Keys } from '../keys/service'
import type { Log } from '../log'
import type { DeliveryRow, MatchStore } from '../match/store'
import { envelopeOf } from '../match/views'

/**
 * **The webhook worker** (decision 6, `docs/match-api.md` "Retries"): the
 * only thing that POSTs. It reads `webhook_deliveries` rows that are due,
 * signs the envelope with the secret the request named, POSTs it, and
 * writes what happened back: `delivered`, the next attempt on the
 * published schedule, `given_up` after the tenth, or `stopped` on a `410`
 * — which also stops every later delivery of the match
 * (`matches.webhooks_stopped_at`).
 *
 * Two ways a delivery gets attempted: a `kick()` right after its row is
 * written (so a live match's facts leave within the tick), and a sweep on
 * the clock every `pollIntervalMs` that picks up whatever a restart or a
 * retry schedule left due. Deliveries of one match are attempted in `seq`
 * order; different matches run side by side; a delivery in its retry wait
 * holds nothing back.
 *
 * The attempt's `fetch` is injected: the process passes the global one, a
 * test passes a function, and the conformance target passes a consumer
 * that verifies the signature before it says 200.
 */
export interface WebhookAttemptReport {
  deliveryId: string
  matchId: string
  seq: number
  attempt: number
  status: number | null
  outcome: 'delivered' | 'retry' | 'stopped' | 'given_up'
}

export interface WebhookWorkerOptions {
  clock: Clock
  log: Log
  store: MatchStore
  keys: Keys
  fetch: typeof globalThis.fetch
  /** How often the sweep runs. Default 5 s. */
  pollIntervalMs?: number
  /** How many matches are delivered to at once. Default 8. */
  concurrency?: number
  /** Every attempt's outcome, for a test or a metric. */
  onAttempt?: (report: WebhookAttemptReport) => void
}

export interface WebhookWorker {
  /** Something is due now: run a pass soon. Cheap; coalesced. */
  kick: () => void
  /** Arm the sweep. Idempotent. */
  start: () => void
  /** Resolve once every attempt in flight has finished. */
  settle: () => Promise<void>
  /** Disarm the sweep and wait for in-flight attempts. */
  close: () => Promise<void>
}

export const WEBHOOK_POLL_INTERVAL_MS = 5_000

export function createWebhookWorker(options: WebhookWorkerOptions): WebhookWorker {
  const { clock, log, store, keys } = options
  const pollIntervalMs = options.pollIntervalMs ?? WEBHOOK_POLL_INTERVAL_MS
  const concurrency = options.concurrency ?? 8
  const inflight = new Set<Promise<void>>()
  const busy = new Set<string>()
  let sweep: Timer | undefined
  let running = false
  let kicked = false
  let pass: Promise<void> | undefined

  const track = (promise: Promise<void>): Promise<void> => {
    const tracked = promise.finally(() => {
      inflight.delete(tracked)
    })
    inflight.add(tracked)
    return tracked
  }

  const post = async (
    row: DeliveryRow,
    body: string,
    signature: string,
  ): Promise<number | null> => {
    let timeout: Timer | undefined
    const deadline = new Promise<null>(resolve => {
      timeout = clock.after(WEBHOOK_ATTEMPT_TIMEOUT_MS, () => resolve(null))
    })
    try {
      const response = await Promise.race([
        options.fetch(row.url, {
          method: 'POST',
          headers: {
            'content-type': WEBHOOK_CONTENT_TYPE,
            [WEBHOOK_SIGNATURE_HEADER]: signature,
            [WEBHOOK_DELIVERY_HEADER]: row.deliveryId,
            [WEBHOOK_ATTEMPT_HEADER]: String(row.attempt + 1),
          },
          body,
        }),
        deadline,
      ])
      return response === null ? null : response.status
    } catch (error) {
      log.warn(`webhook ${row.deliveryId} attempt ${row.attempt + 1}: ${errorText(error)}`)
      return null
    } finally {
      timeout?.cancel()
    }
  }

  const attempt = async (row: DeliveryRow): Promise<void> => {
    const match = await store.findMatch(row.matchId)
    if (!match) return
    const now = clock.date()
    if (match.webhooksStoppedAt) {
      await store.updateDelivery(row.deliveryId, { status: 'stopped', updatedAt: now })
      return
    }
    const [event] = await store.listEvents(row.matchId, row.seq - 1, 1)
    if (!event || event.seq !== row.seq) {
      log.error(`webhook ${row.deliveryId}: no event row for ${row.matchId} seq ${row.seq}`)
      await store.updateDelivery(row.deliveryId, {
        status: 'given_up',
        lastError: 'no event row',
        updatedAt: now,
      })
      return
    }
    const body = JSON.stringify(envelopeOf(match, event))
    const key = await keys.get(match.keyId)
    const secret = key?.webhookSecrets.get(row.secretId)
    // The key rotated its secrets under a running match: sign with nothing
    // rather than with a guess. The consumer refuses it and the events route
    // still has the fact.
    const signature =
      secret === undefined
        ? `t=${Math.floor(clock.now() / 1000)},kid=${row.secretId}`
        : await signWebhook({ body, secretId: row.secretId, secret, clock })
    const status = await post(row, body, signature)
    const number = row.attempt + 1
    const outcome = webhookAttemptOutcome(status)
    const at = clock.date()
    const base = { attempt: number, lastStatus: status, updatedAt: at }
    let reported: WebhookAttemptReport['outcome'] = outcome
    if (outcome === 'delivered') {
      await store.updateDelivery(row.deliveryId, {
        ...base,
        status: 'delivered',
        deliveredAt: at,
        lastError: null,
        nextAttemptAt: null,
      })
    } else if (outcome === 'stopped') {
      await store.updateDelivery(row.deliveryId, {
        ...base,
        status: 'stopped',
        nextAttemptAt: null,
      })
      await store.updateMatch(row.matchId, { webhooksStoppedAt: at, updatedAt: at })
    } else {
      const delay = webhookRetryDelayMs(number)
      if (delay === null) {
        reported = 'given_up'
        await store.updateDelivery(row.deliveryId, {
          ...base,
          status: 'given_up',
          nextAttemptAt: null,
          lastError: status === null ? 'no answer' : `answered ${status}`,
        })
      } else {
        await store.updateDelivery(row.deliveryId, {
          ...base,
          nextAttemptAt: new Date(clock.now() + delay),
          lastError: status === null ? 'no answer' : `answered ${status}`,
        })
        clock.after(delay, kick)
      }
    }
    options.onAttempt?.({
      deliveryId: row.deliveryId,
      matchId: row.matchId,
      seq: row.seq,
      attempt: number,
      status,
      outcome: reported,
    })
  }

  /** One pass: every due row, one match at a time, `concurrency` matches at once. */
  const runPass = async (): Promise<void> => {
    const due = await store.listDueDeliveries(clock.date(), concurrency * 16)
    const byMatch = new Map<string, DeliveryRow[]>()
    for (const row of due) {
      if (busy.has(row.matchId)) continue
      const list = byMatch.get(row.matchId) ?? []
      list.push(row)
      byMatch.set(row.matchId, list)
    }
    const groups = [...byMatch.entries()].slice(0, concurrency)
    await Promise.all(
      groups.map(async ([matchId, rows]) => {
        busy.add(matchId)
        try {
          for (const row of rows) {
            try {
              await attempt(row)
            } catch (error) {
              log.error(`webhook ${row.deliveryId} attempt failed`, error)
            }
          }
        } finally {
          busy.delete(matchId)
        }
      }),
    )
    // More due than one pass took, or rows queued while it ran: go again.
    if (due.length > groups.reduce((n, [, rows]) => n + rows.length, 0) || kicked) {
      kicked = false
      await runPass()
    }
  }

  const schedule = (): void => {
    if (pass) {
      kicked = true
      return
    }
    pass = track(
      runPass()
        .catch((error: unknown) => log.error('webhook pass failed', error))
        .finally(() => {
          pass = undefined
          if (kicked) {
            kicked = false
            schedule()
          }
        }),
    )
  }

  function kick(): void {
    schedule()
  }

  const arm = (): void => {
    sweep = clock.after(pollIntervalMs, () => {
      schedule()
      if (running) arm()
    })
  }

  return {
    kick,
    start() {
      if (running) return
      running = true
      arm()
    },
    async settle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
    async close() {
      running = false
      sweep?.cancel()
      sweep = undefined
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
