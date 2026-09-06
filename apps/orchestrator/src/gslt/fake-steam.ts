import type { Clock } from '@ezpug/core'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { FetchLike } from './steam'

/**
 * **The fake Steam** (PRD-02 T17) — `IGameServersService`'s four methods, in
 * process, on the injected clock, so that "no test needs Steam" is as true
 * as "no test needs Dathost" (CLAUDE.md, offline-first). It is what the
 * pool's tests run against, and what a developer's `pnpm dev:up` mints
 * against when `EZPUG_IRON_STEAM_FAKE_TOKENS` is on: a dev box has no Steam
 * partner key, and a pool that can never hand out a token would hide every
 * bug in the leasing.
 *
 * The subset is exactly what the pool calls: `CreateAccount`,
 * `GetAccountList`, `ResetLoginToken`, `DeleteAccount`. Steam's envelope
 * (`{"response": …}`) and its habit of taking the key as a plain parameter
 * are modelled because the client is wrong without them; nothing else is.
 *
 * Secrets: every login token it makes up starts with {@link FAKE_GSLT_PREFIX}
 * — obviously synthetic and greppable, so a recording that ever caught one
 * is caught by a test rather than by a stranger reading the repo.
 */

/** Every login token this fake mints starts with this. */
export const FAKE_GSLT_PREFIX = 'fake-gslt-'

/** The SteamID64 of the first account it mints; the next is one higher. */
export const FAKE_STEAM_ID_BASE = 90_000_000_000_000_000n

export interface FakeSteamOptions {
  clock: Clock
  /** The key every request must carry. */
  apiKey: string
  /** How many accounts the key may own before Steam refuses. Default 32. */
  accountLimit?: number
}

export interface FakeSteamAccount {
  steamId: string
  appId: number
  loginToken: string
  memo: string
  expired: boolean
}

/** What a test can make go wrong. Off by default. */
export interface FakeSteamFaults {
  /** Answer the next `times` matching requests with `code`; `only` narrows by method name. */
  status?: { code: number; times: number; only?: string }
}

export interface FakeSteam {
  /** The door: hand this to `createSteamGameServers({ fetch })`. */
  readonly fetch: FetchLike
  /** The same app over a real socket, for anything that needs a URL. */
  listen: (options?: { port?: number; hostname?: string }) => Promise<FakeSteamListener>
  /** `Method` for every request that arrived, in order — including the refused ones. */
  readonly calls: string[]
  setFaults: (faults: FakeSteamFaults) => void
  /** Every account the key owns, in creation order. */
  accounts: () => FakeSteamAccount[]
  /** Let an account rot, as Steam does to one nothing has logged into for months. */
  expire: (steamId: string) => void
}

export interface FakeSteamListener {
  url: string
  port: number
  close: () => Promise<void>
}

const DEFAULT_ACCOUNT_LIMIT = 32

export function createFakeSteam(options: FakeSteamOptions): FakeSteam {
  const { clock, apiKey } = options
  const accountLimit = options.accountLimit ?? DEFAULT_ACCOUNT_LIMIT

  const accounts = new Map<string, FakeSteamAccount>()
  const calls: string[] = []
  let faults: FakeSteamFaults = {}
  let statusFaultsLeft = 0
  let counter = 0

  const nextSteamId = (): string => {
    counter += 1
    return String(FAKE_STEAM_ID_BASE + BigInt(counter))
  }

  // The clock is in the token so two tokens of one account differ after a
  // reset, which is the whole point of `ResetLoginToken`.
  const nextToken = (steamId: string): string =>
    `${FAKE_GSLT_PREFIX}${steamId.slice(-6)}-${clock.now().toString(36)}-${counter.toString(36)}`

  const app = new Hono().basePath('/IGameServersService')

  /**
   * The parameters of one request: Steam takes them in the query on a `GET`
   * and in the body on a `POST`. `c.req.text()` is cached by Hono, so the
   * middleware reading the key and the handler reading the rest see the
   * same body.
   */
  const paramsOf = async (c: Context): Promise<URLSearchParams> =>
    c.req.method === 'POST'
      ? new URLSearchParams(await c.req.text())
      : new URLSearchParams(c.req.query())

  app.use('*', async (c, next) => {
    const method = new URL(c.req.url).pathname.split('/')[2] ?? ''
    calls.push(method)
    const params = await paramsOf(c)
    // A wrong key and a missing key look the same, as they do at Steam.
    if (params.get('key') !== apiKey) return new Response(null, { status: 403 })
    if (
      statusFaultsLeft > 0 &&
      faults.status &&
      (!faults.status.only || faults.status.only === method)
    ) {
      statusFaultsLeft -= 1
      return new Response(null, { status: faults.status.code })
    }
    await next()
    return undefined
  })

  app.post('/CreateAccount/v1/', async c => {
    const params = await paramsOf(c)
    // Steam's own ceiling on how many accounts one key may hold.
    if (accounts.size >= accountLimit) return new Response(null, { status: 400 })
    const steamId = nextSteamId()
    const account: FakeSteamAccount = {
      steamId,
      appId: Number(params.get('appid') ?? 730),
      loginToken: nextToken(steamId),
      memo: params.get('memo') ?? '',
      expired: false,
    }
    accounts.set(steamId, account)
    return c.json({ response: { steamid: account.steamId, login_token: account.loginToken } })
  })

  app.post('/DeleteAccount/v1/', async c => {
    const steamId = (await paramsOf(c)).get('steamid') ?? ''
    // Steam refuses an account it does not hold; the pool reads that as done.
    if (!accounts.delete(steamId)) return new Response(null, { status: 400 })
    return c.json({ response: {} })
  })

  app.post('/ResetLoginToken/v1/', async c => {
    const steamId = (await paramsOf(c)).get('steamid') ?? ''
    const account = accounts.get(steamId)
    if (!account) return new Response(null, { status: 400 })
    counter += 1
    account.loginToken = nextToken(steamId)
    account.expired = false
    return c.json({ response: { login_token: account.loginToken } })
  })

  app.get('/GetAccountList/v1/', c =>
    c.json({
      response: {
        servers: [...accounts.values()].map(account => ({
          steamid: account.steamId,
          appid: account.appId,
          login_token: account.loginToken,
          memo: account.memo,
          is_deleted: false,
          is_expired: account.expired,
          rt_last_logon: 0,
        })),
        is_banned: false,
        expires: 0,
        actor: 'fake-steam',
      },
    }),
  )

  app.all('*', () => new Response(null, { status: 404 }))

  return {
    fetch: async (input, init) => await app.fetch(new Request(input, init)),
    calls,
    setFaults(next) {
      faults = next
      statusFaultsLeft = next.status?.times ?? 0
    },
    accounts: () => [...accounts.values()].map(account => ({ ...account })),
    expire(steamId) {
      const account = accounts.get(steamId)
      if (account) account.expired = true
    },
    async listen(listenOptions = {}) {
      const { serve } = await import('@hono/node-server')
      const hostname = listenOptions.hostname ?? '127.0.0.1'
      const server = serve({ fetch: app.fetch, port: listenOptions.port ?? 0, hostname })
      await new Promise<void>(resolve => {
        if (server.listening) resolve()
        else server.once('listening', () => resolve())
      })
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      return {
        url: `http://${hostname}:${port}`,
        port,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()))
          }),
      }
    },
  }
}
