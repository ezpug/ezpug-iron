import { createHash } from 'node:crypto'
import type { Clock } from '@ezpug/core'
import {
  ApiError,
  type ErrorEnvelope,
  flattenRoutes,
  MATCH_API_ERROR_STATUS,
  matchApiRoutes,
} from '@ezpug/match-api'
import { MATCHZY_LOG_PATH } from '@ezpug/protocol'
import { Hono } from 'hono'
import type { HealthReport } from './health'
import type { Dispatch } from './http/dispatch'
import type { RateLimiter } from './http/rate-limit'
import { requestIdOf, requestLog } from './http/request-log'
import type { Log } from './log'
import type { MatchZyDoor } from './matchzy/door'
import {
  baseUrlHost,
  requestHost,
  type WidgetBundles,
  widgetCsp,
  widgetDocument,
  widgetDocumentPath,
  widgetScriptPath,
  widgetStablePath,
} from './widget/bundles'

/**
 * **The HTTP app** — Hono, with one handler per route of the Match API
 * table, generated from the table (the fake's `http.ts`, made real): no
 * route is registered by hand, so the app and the contract cannot disagree
 * about a path or a method. Every non-2xx is the one error envelope; a
 * request without a route is `not_found`; the orchestrator's own fault is
 * `internal` with a request id and a log line, never a stack trace on the
 * wire.
 *
 * Three things live outside `/v1/`: `/healthz` — no key, no scope, the
 * drain's first step (`shutdown.ts`) is what turns it 503 — the MatchZy door
 * (`matchzy/door.ts`), which a server authenticates with its own link token
 * in a header rather than an API key, because it is a server speaking, not
 * a client — and the widget bundles (`widget/bundles.ts`, T25): a gamemode's
 * built widget and the document that frames it, public and immutable at a
 * content-hashed path, no key because a phone in a sandboxed frame has none
 * and the bundle is source from this repo.
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
  /** The MatchZy remote-log door (T9); absent in a composition that serves no server. */
  matchzy?: MatchZyDoor
  /** The gamemode widgets to serve (T25); absent serves none. */
  widgets?: WidgetBundles
  /** The orchestrator's public origin, for the widget document's CSP; absent means the request's host alone. */
  baseUrl?: string
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

  if (options.matchzy) {
    const door = options.matchzy
    app.post(MATCHZY_LOG_PATH, async c => {
      const token = c.req.header(door.tokenHeader)
      // The bucket is the token's own; a POST with none shares the strangers' bucket.
      const taken = rateLimiter.take(rateLimitKey(token ?? null))
      if (!taken.ok) {
        c.header('retry-after', String(Math.ceil(taken.retryAfterMs / 1000)))
        return c.json({ error: 'too many requests' }, 429)
      }
      const answer = await door.handle({ token, body: await c.req.text() })
      return c.json(answer.body, answer.status as 200)
    })
  }

  if (options.widgets) {
    const widgets = options.widgets
    const immutable = 'public, max-age=31536000, immutable'
    const script = (id: string | undefined) => (id ? widgets.get(id) : null)
    app.get(widgetDocumentPath(':id', ':hash'), c => {
      const bundle = script(c.req.param('id'))
      if (!bundle || bundle.hash !== c.req.param('hash')) return c.notFound()
      const hosts = [requestHost(c.req.url, c.req.header('x-forwarded-host'))]
      if (options.baseUrl) hosts.push(baseUrlHost(options.baseUrl))
      c.header('cache-control', immutable)
      c.header('content-security-policy', widgetCsp(hosts))
      c.header('x-content-type-options', 'nosniff')
      c.header('referrer-policy', 'no-referrer')
      return c.html(widgetDocument(bundle.id))
    })
    app.get(widgetScriptPath(':id', ':hash'), c => {
      const bundle = script(c.req.param('id'))
      if (!bundle || bundle.hash !== c.req.param('hash')) return c.notFound()
      c.header('cache-control', immutable)
      c.header('content-type', 'text/javascript; charset=utf-8')
      c.header('x-content-type-options', 'nosniff')
      // A module script in a sandboxed frame is a CORS request from the
      // opaque origin `null`; the bundle is public source, so anyone may.
      c.header('access-control-allow-origin', '*')
      return c.body(bundle.source)
    })
    app.get(widgetStablePath(':id'), c => {
      const bundle = script(c.req.param('id'))
      if (!bundle) return c.notFound()
      const etag = `"${bundle.hash}"`
      c.header('cache-control', 'no-cache')
      c.header('etag', etag)
      c.header('x-content-type-options', 'nosniff')
      c.header('access-control-allow-origin', '*')
      if (c.req.header('if-none-match') === etag) return c.body(null, 304)
      c.header('content-type', 'text/javascript; charset=utf-8')
      return c.body(bundle.source)
    })
  }

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
