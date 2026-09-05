import { Hono } from 'hono'
import { ApiError, type ErrorEnvelope, MATCH_API_ERROR_STATUS } from '../errors'
import { matchApiRoutes } from '../routes'
import { flattenRoutes } from '../rpc'
import type { Dispatch } from './dispatch'

/**
 * **The fake over HTTP**: a Hono app with one handler per route of the table,
 * generated from the table — no route is registered by hand, so the app and
 * the contract cannot disagree about a path or a method. Every non-2xx is
 * the one error envelope; a request without a route is `not_found`.
 *
 * The stream route is an upgrade and Hono never sees one: `listen()` (Node)
 * handles the upgrade on the raw server, and a plain GET on the path gets
 * the explanation the handler throws.
 */

function bearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? (match[1] as string).trim() : null
}

function envelope(error: ApiError): ErrorEnvelope {
  return {
    error: {
      code: error.code === 'unknown_error' ? 'internal' : error.code,
      message: error.message,
      ...(error.details && { details: error.details }),
    },
  }
}

export function createFakeHandler(
  dispatch: Dispatch,
  onError: (error: unknown, context: Record<string, unknown>) => void,
): Hono {
  const app = new Hono()

  for (const flat of flattenRoutes(matchApiRoutes)) {
    const { route } = flat
    app.on(route.method.toUpperCase(), route.path, async c => {
      const apiKey = bearer(c.req.header('authorization'))
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
      const { status, value } = await dispatch(flat, apiKey, {
        params: c.req.param(),
        query: c.req.query(),
        body,
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
      ),
      404,
    ),
  )

  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json(envelope(error), error.status as 400)
    onError(error, { method: c.req.method, path: c.req.path })
    return c.json(
      envelope(
        new ApiError(MATCH_API_ERROR_STATUS.internal, 'internal', 'the fake orchestrator failed'),
      ),
      500,
    )
  })

  return app
}
