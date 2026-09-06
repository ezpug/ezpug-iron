import type { Clock } from '@ezpug/core'
import type { Log } from '../log'

/**
 * **`IGameServersService`, the four calls a GSLT pool needs** (PRD-02 T17).
 *
 * A CS2 server started without a Steam Game Server Login Token logs in
 * anonymously and takes *LAN connections only*
 * (`references/dathost/pages/api-added-cs2-game-server-login-tokens.md`), so
 * a rented box without one is a box nobody outside its datacentre can join.
 * Tokens are minted per app (730) against a Steam Web API key, and this is
 * the whole of the door: create an account, read the account list, reset one
 * account's token, delete an account.
 *
 * Three rules the shape of this module comes from:
 *
 * - **The key is the account.** It never appears in a log line, in an error
 *   message, in a thrown `cause` or in a `provider_meta` — the same posture
 *   as the Dathost Basic header (T16). `CreateAccount`, `DeleteAccount` and
 *   `ResetLoginToken` send it in a form body rather than a query so it is
 *   not in a URL something else might print; `GetAccountList` is a `GET` and
 *   Steam has no other way to take it, so that one URL is never logged.
 * - **A create is never retried.** A repeated `CreateAccount` is a second
 *   Steam account nobody tracks, exactly like a repeated Dathost
 *   `duplicate` is a second server on the bill. The reads and the two
 *   by-SteamID writes are idempotent and are retried, backed off on the
 *   injected clock.
 * - **A refusal says what it was, not what it carried.** {@link SteamError}
 *   holds the method and the status and nothing else; a `403` is the one
 *   worth naming out loud, because it means the key is wrong or has lost
 *   its game-server permission.
 */

/** The `fetch` shape this client is injected with — the fake Steam's front door in a test. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const STEAM_API_BASE_URL = 'https://api.steampowered.com'

/** CS2. The pool never mints for another app; a token is app-scoped. */
export const CS2_APP_ID = 730

/** How long one Steam call may take before it is aborted — on the injected clock. */
export const STEAM_REQUEST_TIMEOUT_MS = 20_000

/** Backoff before the second, third and fourth attempt of a repeatable call. */
export const STEAM_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000]

/** One game server account as Steam holds it. */
export interface SteamGameServerAccount {
  /** The account's SteamID64, as Steam returns it — the pool's key. */
  steamId: string
  appId: number
  /** The login token itself. Held in the process and in `gslt_tokens`, nowhere else. */
  loginToken: string
  memo: string
  /** Steam's own verdict: an account unused for too long stops working. */
  expired: boolean
}

export interface SteamGameServers {
  /** Mint one account for {@link CS2_APP_ID}. Never retried. */
  createAccount: (memo: string) => Promise<SteamGameServerAccount>
  /** Give an account back to Steam. Idempotent by intent; a refusal throws. */
  deleteAccount: (steamId: string) => Promise<void>
  /** A fresh login token for an account — what a lost server's token gets. */
  resetLoginToken: (steamId: string) => Promise<string>
  /** Every account the key owns, of every app; the pool filters by app and memo. */
  listAccounts: () => Promise<SteamGameServerAccount[]>
}

export interface SteamGameServersOptions {
  /** `STEAM_WEB_API_KEY`. Process environment only, never a log line. */
  apiKey: string
  clock: Clock
  appId?: number
  fetch?: FetchLike
  /** Defaults to {@link STEAM_API_BASE_URL}; a test hands it the fake's URL. */
  baseUrl?: string
  log?: Log
  requestTimeoutMs?: number
  retryDelaysMs?: readonly number[]
}

/** A Steam refusal or a broken transport, with nothing secret in it. */
export class SteamError extends Error {
  override readonly name = 'SteamError'
  constructor(
    readonly method: string,
    readonly status: number | null,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

/** 429 and every 5xx are worth another go; a 400 or a 403 is a fact about us. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What Steam wraps every answer in. */
interface SteamEnvelope<T> {
  response?: T
}

interface AccountListEntry {
  steamid?: string
  appid?: number
  login_token?: string
  memo?: string
  is_expired?: boolean
  is_deleted?: boolean
}

function toAccount(entry: AccountListEntry, fallbackAppId: number): SteamGameServerAccount | null {
  if (!entry.steamid || !entry.login_token) return null
  return {
    steamId: String(entry.steamid),
    appId: entry.appid ?? fallbackAppId,
    loginToken: String(entry.login_token),
    memo: entry.memo ?? '',
    expired: entry.is_expired === true,
  }
}

export function createSteamGameServers(options: SteamGameServersOptions): SteamGameServers {
  const { apiKey, clock, log } = options
  const appId = options.appId ?? CS2_APP_ID
  const baseUrl = (options.baseUrl ?? STEAM_API_BASE_URL).replace(/\/+$/, '')
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const requestTimeoutMs = options.requestTimeoutMs ?? STEAM_REQUEST_TIMEOUT_MS
  const retryDelaysMs = options.retryDelaysMs ?? STEAM_RETRY_DELAYS_MS

  /** One attempt, with the timeout armed on the clock. `method` is the API method's name. */
  const attempt = async (
    method: string,
    verb: 'GET' | 'POST',
    params: Record<string, string>,
  ): Promise<Response> => {
    const url = new URL(`${baseUrl}/IGameServersService/${method}/v1/`)
    const body = new URLSearchParams({ key: apiKey, ...params })
    if (verb === 'GET') for (const [name, value] of body) url.searchParams.set(name, value)

    const controller = new AbortController()
    const timeout = clock.after(requestTimeoutMs, () => {
      controller.abort(
        new SteamError(
          method,
          null,
          `steam: ${method} did not answer within ${requestTimeoutMs} ms`,
        ),
      )
    })
    try {
      return await fetchImpl(url.toString(), {
        method: verb,
        headers: {
          accept: 'application/json',
          ...(verb === 'POST' && { 'content-type': 'application/x-www-form-urlencoded' }),
        },
        ...(verb === 'POST' && { body: body.toString() }),
        signal: controller.signal,
      })
    } finally {
      timeout.cancel()
    }
  }

  /** The retry policy. `repeatable: false` is `CreateAccount`, and only it. */
  const call = async <T>(
    method: string,
    verb: 'GET' | 'POST',
    params: Record<string, string>,
    repeatable: boolean,
  ): Promise<T> => {
    const maxAttempts = repeatable ? retryDelaysMs.length + 1 : 1
    for (let round = 1; ; round += 1) {
      let response: Response | null = null
      let failure: unknown
      try {
        response = await attempt(method, verb, params)
      } catch (error) {
        failure = error
      }

      if (response?.ok) {
        let envelope: SteamEnvelope<T>
        try {
          envelope = (await response.json()) as SteamEnvelope<T>
        } catch (error) {
          throw new SteamError(
            method,
            response.status,
            `steam: ${method} answered ${response.status} with a body that is not JSON`,
            error,
          )
        }
        if (!envelope.response)
          throw new SteamError(
            method,
            response.status,
            `steam: ${method} answered no response body`,
          )
        return envelope.response
      }

      const status = response?.status ?? null
      const retryable = round < maxAttempts && (status === null || isRetryableStatus(status))
      if (!retryable) {
        if (status === 403)
          throw new SteamError(
            method,
            status,
            `steam: ${method} answered 403 — STEAM_WEB_API_KEY is wrong, banned, ` +
              'or not allowed to manage game server accounts',
          )
        if (status !== null)
          throw new SteamError(method, status, `steam: ${method} answered ${status}`)
        throw failure instanceof SteamError
          ? failure
          : new SteamError(method, null, `steam: ${method} failed (${errorText(failure)})`, failure)
      }
      const delay = retryDelaysMs[round - 1] ?? 0
      log?.warn(
        `steam: ${method} ${status === null ? `failed (${errorText(failure)})` : `answered ${status}`}` +
          `; retrying in ${delay} ms (attempt ${round + 1}/${maxAttempts})`,
      )
      await clock.sleep(delay)
    }
  }

  return {
    async createAccount(memo) {
      const response = await call<{ steamid?: string; login_token?: string }>(
        'CreateAccount',
        'POST',
        { appid: String(appId), memo },
        false,
      )
      const account = toAccount({ ...response, memo, appid: appId }, appId)
      if (!account)
        throw new SteamError(
          'CreateAccount',
          200,
          'steam: CreateAccount answered without a steamid and a login token',
        )
      return account
    },

    async deleteAccount(steamId) {
      await call('DeleteAccount', 'POST', { steamid: steamId }, true)
    },

    async resetLoginToken(steamId) {
      const response = await call<{ login_token?: string }>(
        'ResetLoginToken',
        'POST',
        { steamid: steamId },
        true,
      )
      if (!response.login_token)
        throw new SteamError(
          'ResetLoginToken',
          200,
          'steam: ResetLoginToken answered without a login token',
        )
      return String(response.login_token)
    },

    async listAccounts() {
      const response = await call<{ servers?: AccountListEntry[] }>(
        'GetAccountList',
        'GET',
        {},
        true,
      )
      const accounts: SteamGameServerAccount[] = []
      for (const entry of response.servers ?? []) {
        if (entry.is_deleted === true) continue
        const account = toAccount(entry, appId)
        if (account) accounts.push(account)
      }
      return accounts
    },
  }
}
