import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Clock } from '@ezpug/core'
import type { StreamCloseCode, StreamFrame } from '@ezpug/match-api'
import {
  ApiError,
  isTerminalMatchState,
  matchApiRoutes,
  matchRoutePath,
  STREAM_CLOSE_CODES,
  scopeAllows,
} from '@ezpug/match-api'
import { type WebSocket, WebSocketServer } from 'ws'
import type { Keys } from '../keys/service'
import type { Log } from '../log'
import type { MatchStore } from '../match/store'
import { hashToken, looksLikeToken } from '../tokens'
import type { StreamHub } from './hub'

/**
 * **Upgrades on the raw server.** Hono never sees an upgrade, so the
 * WebSocket routes — the stream here, `/link` and `/node` in T6 and T12 —
 * are matched on the server's own `upgrade` event, by path, before any
 * framework. One router, attached **before** the port opens and before
 * anything is awaited (the platform's Socket.IO lesson: a listener added
 * after the first upgrade arrives has missed it); a path nobody claimed is
 * answered 404 and hung up.
 */
export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  params: Record<string, string>,
  url: URL,
) => void

export interface UpgradeRouter {
  route: (pathPattern: string, handler: UpgradeHandler) => void
}

export function attachUpgradeRouter(server: HttpServer, options: { log: Log }): UpgradeRouter {
  const routes: { pattern: string; handler: UpgradeHandler }[] = []
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://orchestrator.invalid')
    for (const { pattern, handler } of routes) {
      const params = matchRoutePath(pattern, url.pathname)
      if (!params) continue
      try {
        handler(request, socket, head, params, url)
      } catch (error) {
        options.log.error(`upgrade ${url.pathname} failed`, error)
        socket.destroy()
      }
      return
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })
  return {
    route: (pattern, handler) => void routes.push({ pattern, handler }),
  }
}

/** A subscriber that fell this far behind is dropped rather than buffered forever. */
export const STREAM_SLOW_CONSUMER_BYTES = 1024 * 1024

export interface StreamUpgradeOptions {
  router: UpgradeRouter
  clock: Clock
  log: Log
  keys: Keys
  store: MatchStore
  hub: StreamHub
  /** Once true, new sockets are refused (the drain). */
  isDraining?: () => boolean
}

function bearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? (match[1] as string).trim() : null
}

/**
 * The stream's upgrade (decision 6): authenticate by the bearer header (an
 * API key with `matches` owning the match) or by `?token=` (a player token
 * minted for this match, T24 mints them; this verifies them against the
 * table), check a browser's origin against the request's
 * `streamAllowedOrigins`, say `hello`, subscribe. Refusals are close codes
 * from `STREAM_CLOSE_CODES`; a match that is over gets its `hello` and a
 * `4000` at once.
 */
export function attachStreamUpgrade(options: StreamUpgradeOptions): WebSocketServer {
  const { router, clock, log, keys, store, hub } = options
  const wss = new WebSocketServer({ noServer: true })

  const resolve = async (
    matchId: string,
    request: IncomingMessage,
    url: URL,
  ): Promise<{ ok: true } | { ok: false; code: StreamCloseCode; reason: string }> => {
    const token = url.searchParams.get('token')
    const row = await store.findMatch(matchId)
    if (token !== null) {
      if (!looksLikeToken('player', token))
        return { ok: false, code: STREAM_CLOSE_CODES.unauthorized, reason: 'not a player token' }
      const record = await store.findPlayerTokenByHash(hashToken(token))
      if (!record || record.revokedAt || record.expiresAt.getTime() <= clock.now())
        return { ok: false, code: STREAM_CLOSE_CODES.unauthorized, reason: 'no such player token' }
      if (record.matchId !== matchId)
        return {
          ok: false,
          code: STREAM_CLOSE_CODES.forbidden,
          reason: 'the token is for another match',
        }
      if (!row) return { ok: false, code: STREAM_CLOSE_CODES.notFound, reason: 'no such match' }
      const origin = request.headers.origin
      const allowed = row.requestJson.callbacks.streamAllowedOrigins
      if (origin !== undefined && allowed !== undefined && !allowed.includes(origin))
        return { ok: false, code: STREAM_CLOSE_CODES.forbidden, reason: 'origin not allowed' }
      return { ok: true }
    }
    try {
      const key = await keys.authenticate(bearer(request.headers.authorization))
      if (!scopeAllows(key.key.scopes, 'matches'))
        return {
          ok: false,
          code: STREAM_CLOSE_CODES.forbidden,
          reason: 'the key lacks the matches scope',
        }
      if (!row || row.keyId !== key.key.id)
        return { ok: false, code: STREAM_CLOSE_CODES.notFound, reason: 'no such match' }
      return { ok: true }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'unauthorized')
        return { ok: false, code: STREAM_CLOSE_CODES.unauthorized, reason: error.message }
      throw error
    }
  }

  const serve = async (ws: WebSocket, matchId: string, request: IncomingMessage, url: URL) => {
    if (options.isDraining?.()) {
      ws.close(1001, 'draining')
      return
    }
    const verdict = await resolve(matchId, request, url)
    if (!verdict.ok) {
      ws.close(verdict.code, verdict.reason)
      return
    }
    // The hello reads the match *after* subscribing, so a frame published
    // between the read and the subscription cannot be missed; a frame seen
    // twice is what the deduper is for.
    let unsubscribe: (() => void) | undefined
    const send = (frame: StreamFrame): void => {
      if (ws.readyState !== ws.OPEN) return
      if (ws.bufferedAmount > STREAM_SLOW_CONSUMER_BYTES) {
        unsubscribe?.()
        ws.close(STREAM_CLOSE_CODES.slowConsumer, 'slow consumer')
        return
      }
      ws.send(JSON.stringify(frame))
    }
    unsubscribe = hub.subscribe(matchId, {
      send,
      close: code => ws.close(code),
    })
    ws.on('close', () => unsubscribe?.())
    const row = await store.findMatch(matchId)
    if (!row) {
      unsubscribe()
      ws.close(STREAM_CLOSE_CODES.notFound, 'no such match')
      return
    }
    send({ type: 'hello', matchId: row.id, seq: row.seq, state: row.state })
    if (isTerminalMatchState(row.state)) {
      unsubscribe()
      ws.close(STREAM_CLOSE_CODES.matchEnded, 'the match is over')
    }
  }

  router.route(matchApiRoutes.matches.stream.path, (request, socket, head, params, url) => {
    wss.handleUpgrade(request, socket, head, ws => {
      void serve(ws, params.matchId as string, request, url).catch((error: unknown) => {
        log.error(`stream ${params.matchId} failed`, error)
        ws.close(1011, 'internal')
      })
    })
  })

  return wss
}
