import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemClock } from '@ezpug/core'
import type { Match, MatchRequestInput, PlayerToken } from '@ezpug/match-api'
import {
  createFakeOrchestrator,
  type FakeListener,
  type FakeOrchestrator,
} from '@ezpug/match-api/fake'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import { type WidgetPaths, widgetVuePlugin } from './vite'

/**
 * **`ezpug-widget dev <id>`** — the harness (decision 17, PRD-02 T25): the
 * widget under Vite's dev server, mounted the way the platform mounts it —
 * a sandboxed `iframe` on a document shaped like the orchestrator's, the
 * `postMessage` handshake with the design tokens, a locale switch and a
 * "watching only" switch — against the published fake orchestrator running
 * in this process on the wall clock, with a simulated match of the mode and
 * a player token minted for a rostered player. No CS2, no Postgres, no
 * platform: the socket the widget opens is a real one, to the fake's
 * `/v1/widget`.
 *
 * The session (`GET /__harness/session`) is the fake's URL, the match and
 * the token — read by the harness page over the dev server, never put in a
 * URL. `POST /__harness/session` starts a fresh match once the last one
 * ended.
 *
 * **Pushes** (PRD-02 T26): a mode whose widget draws something the plugin
 * pushes at one phone has nothing to draw here — the fake's simulated server
 * runs a stand-in mode with no opinion about when a push is due. So the
 * harness fires them by hand: a mode may ship a
 * `widget/harness-pushes.json` (a list of `{ label, name, data }`), the page
 * puts a button behind each one, and `POST /__harness/push` hands it to
 * `fake.widgetPush` exactly as a real orchestrator relays a plugin's
 * `widget_push`. The socket, the frame and the drawing are the real ones;
 * only the reason it arrived is made up.
 */

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'harness')
/** The harness player: on the roster, so the token is minted without open join. */
export const HARNESS_PLAYER = {
  steamId64: '76561198000000001',
  name: 'Widget',
  locale: 'de',
} as const

export interface HarnessSession {
  orchestratorUrl: string
  gamemode: string
  matchId: string
  steamId64: string
  playerToken: string
  expiresAt: string
  state: Match['state']
  /** The sample pushes this mode ships, as buttons for the page. */
  pushes: HarnessPush[]
}

/** One entry of a mode's `widget/harness-pushes.json`. */
export interface HarnessPush {
  /** What the button says. */
  label: string
  /** The push's name, the mode's own word for it (`radar_peek`). */
  name: string
  data: Record<string, unknown>
}

export interface HarnessOptions {
  port?: number
  host?: string
  /** The simulated match's time scale (`sim.timeScale`, 0.25–600). Default 1. */
  timeScale?: number
}

export interface Harness {
  url: string
  fake: FakeOrchestrator
  listener: FakeListener
  session: () => Promise<HarnessSession>
  close: () => Promise<void>
}

function manifestOf(paths: WidgetPaths): { id: string; maps: unknown; slots: { teams: number } } {
  return JSON.parse(readFileSync(join(paths.dir, 'manifest.json'), 'utf8'))
}

/** A mode's sample pushes, or none. A file that does not parse is a warning, not a dead harness. */
function pushesOf(paths: WidgetPaths): HarnessPush[] {
  const file = join(paths.dir, 'widget', 'harness-pushes.json')
  if (!existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is HarnessPush =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as HarnessPush).label === 'string' &&
        typeof (entry as HarnessPush).name === 'string' &&
        typeof (entry as HarnessPush).data === 'object',
    )
  } catch (error) {
    console.warn(`[harness] ${file} does not parse; no push buttons`, error)
    return []
  }
}

export async function startHarness(
  paths: WidgetPaths,
  options: HarnessOptions = {},
): Promise<Harness> {
  const manifest = manifestOf(paths)
  const pushes = pushesOf(paths)
  const fake = createFakeOrchestrator({
    clock: systemClock,
    // The fake would POST every durable fact to the request's webhook URL; the
    // harness has no platform to post to and nothing to prove about delivery.
    fetch: () => Promise.resolve(new Response(null, { status: 200 })),
    onError: (error, context) => console.error('[harness] fake orchestrator:', context, error),
  })
  const listener = await fake.listen({ port: 0 })
  // The harness's own key: the fake checks a request's `webhookSecretId`
  // against the key's registered secrets, so one is registered — obviously
  // fake, for a webhook nobody receives.
  const key = fake.mintKey({
    name: 'widget-harness',
    scopes: ['matches'],
    budget: { maxConcurrentServers: 4, maxServerLifetimeMinutes: 240, monthlyCents: 0 },
    webhookSecrets: [{ id: 'harness', secret: 'the-widget-harness-secret-nobody-verifies' }],
  })
  const api = fake.client(key.secret)

  let current: HarnessSession | null = null
  let starting: Promise<HarnessSession> | null = null

  const firstMap = (): string => {
    const maps = manifest.maps
    if (maps && typeof maps === 'object' && 'catalog' in maps) {
      const catalog = (maps as { catalog: string[] }).catalog
      return catalog[0] ?? 'de_mirage'
    }
    return 'de_mirage'
  }

  const start = async (): Promise<HarnessSession> => {
    const body: MatchRequestInput = {
      clientMatchId: `harness-${systemClock.now().toString(36)}`,
      game: 'cs2',
      gamemode: manifest.id,
      teams: {
        teamA: { name: 'Harness', players: [HARNESS_PLAYER] },
        teamB: { name: 'Niemand', players: [] },
      },
      maps: [{ map: firstMap(), sides: 'ct' }],
      callbacks: {
        webhookUrl: 'https://harness.invalid/hooks',
        webhookSecretId: 'harness',
        streamAllowedOrigins: [`http://${options.host ?? '127.0.0.1'}:${options.port ?? 3432}`],
      },
      requirements: { simulated: true },
      sim: { timeScale: options.timeScale ?? 1 },
      ttlMinutes: 120,
    }
    const created = await api.matches.create({ body })
    const params = { matchId: created.id }
    let match: Match = created
    while (match.state !== 'live') {
      if (match.state === 'failed' || match.state === 'cancelled' || match.state === 'ended')
        throw new Error(`the harness match ended before it went live (${match.state})`)
      await systemClock.sleep(250)
      match = await api.matches.get({ params })
    }
    const token: PlayerToken = await api.matches.mintPlayerToken({
      params,
      body: { steamId64: HARNESS_PLAYER.steamId64 },
    })
    current = {
      orchestratorUrl: listener.url,
      gamemode: manifest.id,
      matchId: created.id,
      steamId64: HARNESS_PLAYER.steamId64,
      playerToken: token.token,
      expiresAt: token.expiresAt,
      state: match.state,
      pushes,
    }
    return current
  }

  const session = async (fresh = false): Promise<HarnessSession> => {
    if (starting) return starting
    if (current && !fresh) {
      const match = await api.matches.get({ params: { matchId: current.matchId } })
      current = { ...current, state: match.state }
      if (match.state === 'live') return current
    }
    starting = start().finally(() => {
      starting = null
    })
    return starting
  }

  const harnessPlugin: Plugin = {
    name: 'ezpug-widget-harness',
    configureServer(server) {
      server.middlewares.use('/__harness/push', (req: IncomingMessage, res: ServerResponse) => {
        const answer = (status: number, body: unknown): void => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(body))
        }
        const index = Number(new URL(req.url ?? '/', 'http://harness').searchParams.get('i') ?? '0')
        const push = pushes[index]
        if (!current || !push) {
          answer(404, { error: current ? `no push ${index}` : 'no session yet' })
          return
        }
        const phones = fake.widgetPush(current.matchId, current.steamId64, {
          type: 'push',
          name: push.name,
          data: push.data,
        })
        answer(200, { name: push.name, phones })
      })
      server.middlewares.use('/__harness/session', (req: IncomingMessage, res: ServerResponse) => {
        const fresh = req.method === 'POST'
        session(fresh).then(
          value => {
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify(value))
          },
          error => {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: String(error?.message ?? error) }))
          },
        )
      })
    },
  }

  const vite: ViteDevServer = await createServer({
    configFile: false,
    root: HARNESS_DIR,
    appType: 'mpa',
    logLevel: 'info',
    plugins: [widgetVuePlugin(), harnessPlugin],
    resolve: { alias: { '/@widget': paths.entry } },
    server: {
      port: options.port ?? 3432,
      host: options.host ?? '127.0.0.1',
      strictPort: true,
      // The frame is sandboxed without `allow-same-origin`, so its module
      // script is a cross-origin request from the opaque origin `null` —
      // exactly what the orchestrator's script route allows too.
      cors: { origin: '*' },
      fs: { allow: [HARNESS_DIR, paths.dir, join(HARNESS_DIR, '..', '..')] },
    },
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 3432)
  const url = `http://${options.host ?? '127.0.0.1'}:${port}/`

  return {
    url,
    fake,
    listener,
    session: () => session(false),
    async close() {
      await vite.close()
      await listener.close()
      fake.close()
    },
  }
}
