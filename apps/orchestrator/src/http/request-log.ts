import { randomUUID } from 'node:crypto'
import type { Clock } from '@ezpug/core'
import type { Context, MiddlewareHandler } from 'hono'
import type { Log } from '../log'
import { apiKeyPrefix } from '../tokens'

/**
 * **One line per request, no secrets in it.** Method, the path *without its
 * query string* (the stream route carries a player token in `?token=`), the
 * status, the duration on the clock, the API key's public prefix when one
 * was presented (never the key), and the request id — echoed back as
 * `x-request-id`, taken from the caller's when it sent a plausible one, so a
 * client's log and this one name the same request.
 */
export const REQUEST_ID_HEADER = 'x-request-id'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/

export function requestIdOf(c: Context): string {
  return c.get('requestId') as string
}

export function requestLog(options: { clock: Clock; log: Log }): MiddlewareHandler {
  const { clock, log } = options
  return async (c, next) => {
    const presented = c.req.header(REQUEST_ID_HEADER)
    const requestId = presented && REQUEST_ID_PATTERN.test(presented) ? presented : randomUUID()
    c.set('requestId', requestId)
    c.header(REQUEST_ID_HEADER, requestId)
    const startedAt = clock.now()
    try {
      await next()
    } finally {
      const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim()
      const who = bearer ? ` key=${apiKeyPrefix(bearer)}…` : ''
      log.info(
        `${c.req.method} ${c.req.path} ${c.res.status} ${clock.now() - startedAt}ms${who} rid=${requestId}`,
      )
    }
  }
}
