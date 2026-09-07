import { ApiError } from '../errors'
import { matchApiRoutes } from '../routes'
import { matchRoutePath } from '../rpc'
import {
  WIDGET_CLOSE_CODES,
  WIDGET_HELLO_TIMEOUT_MS,
  WIDGET_SOCKET_PROTOCOL,
  type WidgetCloseCode,
  widgetClientFrameSchema,
} from '../widget/socket'
import { streamCloseCodeFor } from './core'
import type { FakeListener, FakeListenOptions, FakeOrchestrator, FakeWidgetSession } from './types'

/** A refused widget hello as a close code. */
function widgetCloseCodeFor(error: unknown): WidgetCloseCode {
  if (error instanceof ApiError && error.code === 'unauthorized')
    return WIDGET_CLOSE_CODES.unauthorized
  return WIDGET_CLOSE_CODES.forbidden
}

/**
 * **The fake over a real socket** — Node only, loaded on demand so the module
 * stays importable everywhere: `@hono/node-server` serves the Hono app and
 * `ws` performs the two upgrades: `GET /v1/matches/:matchId/stream`, with
 * the API key from the `Authorization` header or a player token from
 * `?token=`, and `GET /v1/widget`, whose first frame is the widget's `hello`
 * with its token (decision 17) — a socket that says nothing else first is
 * closed `malformed`, one that says nothing at all within
 * `WIDGET_HELLO_TIMEOUT_MS` on the fake's clock is closed `helloTimeout`.
 * Close it before the test ends; an HTTP server that outlives a test is a
 * working rule broken.
 */
export async function listenFake(
  fake: Pick<FakeOrchestrator, 'handler' | 'stream' | 'widget' | 'clock'>,
  options: FakeListenOptions = {},
): Promise<FakeListener> {
  const [{ serve }, { WebSocketServer }] = await Promise.all([
    import('@hono/node-server'),
    import('ws'),
  ])
  const hostname = options.hostname ?? '127.0.0.1'
  const server = serve({ fetch: fake.handler.fetch, port: options.port ?? 0, hostname })
  await new Promise<void>(resolve => {
    if (server.listening) resolve()
    else server.once('listening', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${hostname}`)
    if (matchRoutePath(matchApiRoutes.widget.path, url.pathname)) {
      wss.handleUpgrade(request, socket, head, ws => {
        let session: FakeWidgetSession | undefined
        const timeout = fake.clock.after(WIDGET_HELLO_TIMEOUT_MS, () => {
          if (!session) ws.close(WIDGET_CLOSE_CODES.helloTimeout, 'no hello')
        })
        ws.on('message', data => {
          let frame: ReturnType<typeof widgetClientFrameSchema.parse>
          try {
            const raw = JSON.parse(String(data)) as { protocol?: unknown; type?: unknown }
            if (
              raw.type === 'hello' &&
              typeof raw.protocol === 'number' &&
              raw.protocol !== WIDGET_SOCKET_PROTOCOL
            ) {
              ws.close(WIDGET_CLOSE_CODES.protocolMismatch, 'protocol')
              return
            }
            frame = widgetClientFrameSchema.parse(raw)
          } catch {
            ws.close(WIDGET_CLOSE_CODES.malformed, 'malformed')
            return
          }
          if (!session) {
            if (frame.type !== 'hello') {
              ws.close(WIDGET_CLOSE_CODES.malformed, 'hello first')
              return
            }
            timeout.cancel()
            try {
              session = fake.widget(
                frame.token,
                answer => ws.send(JSON.stringify(answer)),
                code => ws.close(code),
              )
            } catch (error) {
              ws.close(widgetCloseCodeFor(error))
            }
            return
          }
          if (frame.type === 'hello') {
            ws.close(WIDGET_CLOSE_CODES.malformed, 'hello twice')
            return
          }
          void session.command(frame)
        })
        ws.on('close', () => {
          timeout.cancel()
          session?.close()
        })
      })
      return
    }
    const params = matchRoutePath(matchApiRoutes.matches.stream.path, url.pathname)
    if (!params) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, ws => {
      const header = request.headers.authorization
      const apiKey = header ? /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() : undefined
      const token = url.searchParams.get('token') ?? undefined
      try {
        const unsubscribe = fake.stream(
          { matchId: params.matchId as string, apiKey, token },
          frame => ws.send(JSON.stringify(frame)),
          code => ws.close(code),
        )
        ws.on('close', unsubscribe)
      } catch (error) {
        ws.close(streamCloseCodeFor(error))
      }
    })
  })

  return {
    url: `http://${hostname}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate()
        wss.close()
        server.close(error => (error ? reject(error) : resolve()))
      }),
  }
}
