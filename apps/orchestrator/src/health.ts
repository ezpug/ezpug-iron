import type { Clock } from '@ezpug/core'

/**
 * **What `/healthz` says** — one check per rail this process stands on: the
 * database, Redis, and every registered provider (none until T3/T4; the
 * list is here so the shape does not change when they arrive). A check
 * that throws is `ok: false` with the error's message, redacted by whoever
 * built it; a check that hangs is bounded on the clock, so a wedged pool
 * answers "unhealthy" rather than never.
 */
export interface HealthCheck {
  ok: boolean
  latencyMs: number
  error?: string
}

export interface HealthReport {
  ok: boolean
  checks: {
    database: HealthCheck
    redis: HealthCheck
    providers: Record<string, HealthCheck>
  }
}

export interface HealthOptions {
  clock: Clock
  database: () => Promise<void>
  redis: () => Promise<void>
  /** Registered providers, by id, each answering one probe. */
  providers?: Record<string, () => Promise<void>>
  /** The longest one check may take before it counts as failed. */
  timeoutMs?: number
}

export const HEALTH_CHECK_TIMEOUT_MS = 2_000

export function createHealth(options: HealthOptions): () => Promise<HealthReport> {
  const { clock } = options
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS

  const probe = async (run: () => Promise<void>): Promise<HealthCheck> => {
    const startedAt = clock.now()
    let timer: { cancel: () => void } | undefined
    try {
      await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timer = clock.after(timeoutMs, () => reject(new Error(`no answer within ${timeoutMs}ms`)))
        }),
      ])
      return { ok: true, latencyMs: clock.now() - startedAt }
    } catch (error) {
      return {
        ok: false,
        latencyMs: clock.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      timer?.cancel()
    }
  }

  return async () => {
    const providerEntries = Object.entries(options.providers ?? {})
    const [database, redis, ...providerChecks] = await Promise.all([
      probe(options.database),
      probe(options.redis),
      ...providerEntries.map(([, run]) => probe(run)),
    ])
    const providers = Object.fromEntries(
      providerEntries.map(([id], index) => [id, providerChecks[index] as HealthCheck]),
    )
    return {
      ok: database.ok && redis.ok && Object.values(providers).every(check => check.ok),
      checks: { database, redis, providers },
    }
  }
}
