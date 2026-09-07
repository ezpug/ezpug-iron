import type { IncomingMessage } from 'node:http'
import type { Clock } from '@ezpug/core'
import type { WidgetCommandFrame, WidgetServerFrame } from '@ezpug/match-api'
import {
  matchApiRoutes,
  WIDGET_CLOSE_CODES,
  WIDGET_HELLO_TIMEOUT_MS,
  WIDGET_SOCKET_PROTOCOL,
  widgetClientFrameSchema,
} from '@ezpug/match-api'
import { type WebSocket, WebSocketServer } from 'ws'
import type { Log } from '../log'
import { STREAM_SLOW_CONSUMER_BYTES, type UpgradeRouter } from '../stream/upgrade'
import type { WidgetService, WidgetSession } from './service'

/**
 * **The widget socket** (decision 17, PRD-02 T24): `GET /v1/widget`, matched
 * on the raw server before Hono like the stream and the links. The first
 * frame must be the widget's `hello` with its player token — within
 * `WIDGET_HELLO_TIMEOUT_MS` on the clock, or the socket is closed
 * `helloTimeout`; a first frame that is not a `hello`, or any frame that
 * does not parse, is `malformed`; a `hello` on another protocol is
 * `protocolMismatch`. Everything after the greeting is `widget/service.ts`:
 * this file only turns bytes into frames and back, and closes the socket
 * when the session ends or the widget falls a megabyte behind.
 *
 * Nothing about the token is logged: not the frame, not the URL (there is
 * nothing in the URL), not the refusal.
 */
export interface WidgetUpgradeOptions {
  router: UpgradeRouter
  clock: Clock
  log: Log
  widgets: WidgetService
  helloTimeoutMs?: number
  /** Once true, new sockets are refused (the drain). */
  isDraining?: () => boolean
}

export interface WidgetUpgrade {
  readonly wss: WebSocketServer
  /** Sockets open right now. */
  size: () => number
  /** Close every socket with the code — the drain's step. */
  close: (code: number, reason: string) => Promise<void>
}

export function attachWidgetUpgrade(options: WidgetUpgradeOptions): WidgetUpgrade {
  const { router, clock, log, widgets } = options
  const helloTimeoutMs = options.helloTimeoutMs ?? WIDGET_HELLO_TIMEOUT_MS
  const wss = new WebSocketServer({ noServer: true })

  const serve = (ws: WebSocket, request: IncomingMessage): void => {
    if (options.isDraining?.()) {
      ws.close(1001, 'draining')
      return
    }
    let session: WidgetSession | undefined
    let opening = false
    /** Commands that arrived while the hello was being answered — a widget may tap right after it says hello. */
    const pending: WidgetCommandFrame[] = []
    const relay = (frame: WidgetCommandFrame): void => {
      void session?.command(frame).catch((error: unknown) => {
        log.error('widget command failed', error)
        ws.close(1011, 'internal')
      })
    }
    const helloTimer = clock.after(helloTimeoutMs, () => {
      if (!session && !opening) ws.close(WIDGET_CLOSE_CODES.helloTimeout, 'no hello')
    })
    const write = (frame: WidgetServerFrame): void => {
      if (ws.readyState !== ws.OPEN) return
      if (ws.bufferedAmount > STREAM_SLOW_CONSUMER_BYTES) {
        session?.close()
        ws.close(WIDGET_CLOSE_CODES.slowConsumer, 'slow consumer')
        return
      }
      ws.send(JSON.stringify(frame))
    }
    ws.on('message', data => {
      let raw: unknown
      try {
        raw = JSON.parse(String(data))
      } catch {
        ws.close(WIDGET_CLOSE_CODES.malformed, 'not JSON')
        return
      }
      const probe = raw as { type?: unknown; protocol?: unknown } | null
      if (
        probe?.type === 'hello' &&
        typeof probe.protocol === 'number' &&
        probe.protocol !== WIDGET_SOCKET_PROTOCOL
      ) {
        ws.close(WIDGET_CLOSE_CODES.protocolMismatch, `protocol ${WIDGET_SOCKET_PROTOCOL}`)
        return
      }
      const parsed = widgetClientFrameSchema.safeParse(raw)
      if (!parsed.success) {
        ws.close(WIDGET_CLOSE_CODES.malformed, 'malformed frame')
        return
      }
      const frame = parsed.data
      if (!session) {
        if (opening) {
          if (frame.type === 'hello') ws.close(WIDGET_CLOSE_CODES.malformed, 'hello twice')
          else pending.push(frame)
          return
        }
        if (frame.type !== 'hello') {
          ws.close(WIDGET_CLOSE_CODES.malformed, 'hello first')
          return
        }
        opening = true
        helloTimer.cancel()
        const origin = request.headers.origin
        void widgets
          .open(
            { token: frame.token, ...(origin !== undefined && { origin }) },
            {
              send: write,
              close: (code, reason) => ws.close(code, reason),
            },
          )
          .then(result => {
            opening = false
            if (!result.ok) {
              ws.close(result.code, result.reason)
              return
            }
            session = result.session
            if (ws.readyState !== ws.OPEN) {
              session.close()
              return
            }
            for (const queued of pending.splice(0)) relay(queued)
          })
          .catch((error: unknown) => {
            opening = false
            log.error('widget hello failed', error)
            ws.close(1011, 'internal')
          })
        return
      }
      if (frame.type === 'hello') {
        ws.close(WIDGET_CLOSE_CODES.malformed, 'hello twice')
        return
      }
      relay(frame)
    })
    ws.on('close', () => {
      helloTimer.cancel()
      session?.close()
    })
  }

  router.route(matchApiRoutes.widget.path, (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => serve(ws, request))
  })

  return {
    wss,
    size: () => wss.clients.size,
    close: (code, reason) => {
      widgets.close(code as Parameters<WidgetService['close']>[0], reason)
      for (const client of wss.clients) client.close(code, reason)
      return new Promise<void>(resolve => wss.close(() => resolve()))
    },
  }
}
