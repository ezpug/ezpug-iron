import { matchApiRoutes } from '../routes'
import { matchRoutePath } from '../rpc'
import { streamCloseCodeFor } from './core'
import type { FakeListener, FakeListenOptions, FakeOrchestrator } from './types'

/**
 * **The fake over a real socket** — Node only, loaded on demand so the module
 * stays importable everywhere: `@hono/node-server` serves the Hono app and
 * `ws` performs the upgrade on `GET /v1/matches/:matchId/stream`, with the
 * API key from the `Authorization` header or a player token from `?token=`,
 * and the stream's close codes when refused. Close it before the test ends;
 * an HTTP server that outlives a test is a working rule broken.
 */
export async function listenFake(
  fake: Pick<FakeOrchestrator, 'handler' | 'stream'>,
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
