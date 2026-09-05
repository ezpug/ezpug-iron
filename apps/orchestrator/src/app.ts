import { createHash } from 'node:crypto'
import type { Clock } from '@ezpug/core'
import {
  ApiError,
  type ErrorEnvelope,
  flattenRoutes,
  MATCH_API_ERROR_STATUS,
  matchApiRoutes,
} from '@ezpug/match-api'
import { Hono } from 'hono'
import type { HealthReport } from './health'
import type { Dispatch } from './http/dispatch'
import type { RateLimiter } from './http/rate-limit'
import { requestIdOf, requestLog } from './http/request-log'
import type { Log } from './log'

/**
 * **The HTTP app** — Hono, with one handler per route of the Match API
 * table, generated from the table (the fake's `http.ts`, made real): no
 * route is registered by hand, so the app and the contract cannot disagree
 * about a path or a method. Every non-2xx is the one error envelope; a
 * request without a route is `not_found`; the orchestrator's own fault is
 * `internal` with a request id and a log line, never a stack trace on the
 * wire.
 *
 * `/healthz` is the one path outside `/v1/`: no key, no scope, the drain's
 * first step (`shutdown.ts`) is what turns it 503.
 *
 * The stream route is an upgrade and Hono never sees one: the listener
 * (T3) handles the upgrade on the raw server, and a plain GET on the path
 * gets the explanation its handler throws.
 */

export interface AppOptions {
  clock: Clock
  log: Log
  dispatch: Dispatch
  rateLimiter: RateLimiter
  /** What `/healthz` asks. */
  health: () => Promise<HealthReport>
  /** The first step of the drain: once true, `/healthz` answers 503. */
  isDraining?: () => boolean
}

type Variables = { requestId: string }

function bearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? (match[1] as string).trim() : null
}

function envelope(error: ApiError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: error.code === 'unknown_error' ? 'internal' : error.code,
      message: error.message,
      details: { ...error.details, requestId },
    },
  }
}

/** The bucket a request draws from: the presented key, hashed, or nobody. */
function rateLimitKey(presented: string | null): string {
  return presented ? createHash('sha256').update(presented).digest('hex') : 'anonymous'
}

export function createApp(options: AppOptions): Hono<{ Variables: Variables }> {
  const { dispatch, rateLimiter, log } = options
  const app = new Hono<{ Variables: Variables }>()

  app.use('*', requestLog({ clock: options.clock, log }))

  app.get('/healthz', async c => {
    const draining = options.isDraining?.() === true
    const report = await options.health()
    const ok = report.ok && !draining
    return c.json(
      {
        ok,
        service: 'orchestrator',
        ...(draining ? { state: 'draining' as const } : {}),
        checks: report.checks,
      },
      ok ? 200 : 503,
    )
  })

  for (const flat of flattenRoutes(matchApiRoutes)) {
    const { route } = flat
    app.on(route.method.toUpperCase(), route.path, async c => {
      const presented = bearer(c.req.header('authorization'))
      const taken = rateLimiter.take(rateLimitKey(presented))
      if (!taken.ok) {
        c.header('retry-after', String(Math.ceil(taken.retryAfterMs / 1000)))
        throw new ApiError(
          MATCH_API_ERROR_STATUS.rate_limited,
          'rate_limited',
          'too many requests; back off',
          { retryAfterMs: taken.retryAfterMs },
        )
      }
      let body: unknown
      if (route.body) {
        const text = await c.req.text()
        try {
          body = text.length > 0 ? JSON.parse(text) : undefined
        } catch {
          throw new ApiError(
            MATCH_API_ERROR_STATUS.validation_failed,
            'validation_failed',
            'the body is not JSON',
          )
        }
      }
      const { status, value } = await dispatch(flat, presented, {
        params: c.req.param(),
        query: c.req.query(),
        body,
        requestId: requestIdOf(c),
      })
      return c.json(value as Record<string, unknown>, status as 200)
    })
  }

  app.notFound(c =>
    c.json(
      envelope(
        new ApiError(
          MATCH_API_ERROR_STATUS.not_found,
          'not_found',
          `no route ${c.req.method} ${c.req.path}`,
        ),
        requestIdOf(c),
      ),
      404,
    ),
  )

  app.onError((error, c) => {
    const requestId = requestIdOf(c)
    if (error instanceof ApiError) return c.json(envelope(error, requestId), error.status as 400)
    log.error(`${c.req.method} ${c.req.path} failed (rid=${requestId})`, error)
    return c.json(
      envelope(
        new ApiError(MATCH_API_ERROR_STATUS.internal, 'internal', 'the orchestrator failed'),
        requestId,
      ),
      500,
    )
  })

  return app
}

export type App = ReturnType<typeof createApp>
