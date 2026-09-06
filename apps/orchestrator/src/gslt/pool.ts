import { randomUUID } from 'node:crypto'
import type { Clock, Timer } from '@ezpug/core'
import type { Log } from '../log'
import type { GsltTokenRow, MatchStore } from '../match/store'
import type { SteamGameServers } from './steam'

/**
 * **The GSLT pool** (PRD-02 T17) — the small set of Steam game server
 * accounts this deployment owns, one login token each, leased to a ledger
 * row while a rented server is running on it.
 *
 * Why it exists: a CS2 server started without a token logs in anonymously
 * and **accepts LAN connections only**
 * (`references/dathost/pages/api-added-cs2-game-server-login-tokens.md`), so
 * a Dathost clone without one is a box no player can reach. A node at a
 * venue needs none — everybody there is on the LAN — which is why only the
 * Dathost provider holds this seam.
 *
 * The rules, each of which is a test:
 *
 * - **One token, one running server.** Valve's rule: a token logged in
 *   twice evicts the first login. So a lease is a single atomic write
 *   (`claimFreeGsltToken`), it is keyed by the **ledger row** — the one
 *   identity a server has from before it exists until after it is gone —
 *   and the pool hands out the *longest-idle* free account, so a token has
 *   the most possible time to be forgotten before it is used again.
 * - **The ceiling is a wall, not a target.** Nothing is minted until a lease
 *   asks for a token there is none of; the pool grows to peak concurrency
 *   and stops at {@link DEFAULT_POOL_MAX}. A `CreateAccount` is never
 *   retried — a repeated create is a Steam account nobody tracks, exactly
 *   like a repeated Dathost `duplicate` is a server nobody stops paying for.
 * - **A dry pool is a warning, never a refusal.** `lease` answers `null`
 *   and says so once; the provider starts the server LAN-only rather than
 *   failing the match, because half a match is worth more than none and the
 *   operator can read the reason in the log and in `GET /v1/fleet/gslt`.
 * - **A lost server's token is reset.** A box that vanished may still be
 *   logged in with the token it was given; `ResetLoginToken` makes the old
 *   one worthless before the next server gets it.
 * - **A crash cannot leak a lease.** The sweep frees every lease whose
 *   ledger row is closed or gone (`listLeakedGsltLeases`), so the pool
 *   heals whatever a process that died between `deallocate` and `release`
 *   left behind, and `reconcile()` reads Steam's own account list to adopt
 *   accounts this deployment minted and forgot and to reset the ones Steam
 *   let expire.
 *
 * Tokens never leave this process except into the provider call that plants
 * one on a server: not into a log line, not into an error, not into
 * `provider_meta`, not into the fleet's answers — `GET /v1/fleet/gslt` is
 * two integers.
 */

/** How many Steam accounts this deployment will hold. `EZPUG_IRON_GSLT_POOL_MAX`. */
export const DEFAULT_POOL_MAX = 16

/** How often the sweep frees leaked leases and reconciles with Steam. */
export const DEFAULT_POOL_SWEEP_INTERVAL_MS = 5 * 60_000

/** What every account this deployment mints is called at Steam. */
export const GSLT_MEMO_PREFIX = 'ezpug-iron'

/** What `GET /v1/fleet/gslt` answers. */
export interface GsltPoolStats {
  /** Accounts held (leased or free). */
  total: number
  /** Accounts on a server right now. */
  inUse: number
}

export interface GsltPool {
  /**
   * The token for a ledger row, minting one if the pool is dry and below
   * its ceiling. Idempotent: a row that already holds a lease gets the same
   * token back. `null` means LAN only.
   */
  lease: (fleetServerId: string) => Promise<string | null>
  /**
   * Give a lease back. Idempotent — a row with no lease releases
   * successfully. `lost: true` resets the token at Steam first, because a
   * server nobody could stop may still be logged in with it.
   */
  release: (fleetServerId: string, options?: { lost?: boolean }) => Promise<void>
  stats: () => Promise<GsltPoolStats>
  /** Free leaked leases and, when Steam is reachable, reconcile with the account list. */
  sweep: () => Promise<void>
  /** Arm the sweep. Idempotent. */
  start: () => void
  /** Disarm; a pass already running finishes. */
  stop: () => Promise<void>
}

export interface GsltPoolOptions {
  clock: Clock
  log: Log
  store: MatchStore
  /**
   * The Steam door, or absent. Without it the pool leases what rows exist
   * and mints nothing — the honest state of a deployment with no
   * `STEAM_WEB_API_KEY`, which is every developer's box.
   */
  steam?: SteamGameServers
  /** The ceiling. Default {@link DEFAULT_POOL_MAX}. */
  max?: number
  /**
   * What the memo of a minted account says after the prefix — the
   * deployment's own name, so one Steam key shared by two deployments still
   * says which account is whose.
   */
  deployment?: string
  sweepIntervalMs?: number
}

export function createGsltPool(options: GsltPoolOptions): GsltPool {
  const { clock, log, store, steam } = options
  const max = options.max ?? DEFAULT_POOL_MAX
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_POOL_SWEEP_INTERVAL_MS
  const memo = `${GSLT_MEMO_PREFIX} ${options.deployment ?? 'dev'}`.trim()

  let timer: Timer | undefined
  let running = false
  let pass: Promise<void> | undefined
  let warnedDry = false
  let warnedNoSteam = false

  /**
   * Every lease and every mint runs on one chain. One process holds this
   * pool, and the moment two allocations overlap is exactly the moment a
   * mint decision is made on a count that is about to change — the database
   * claim is atomic, the "is there room for one more" is not.
   */
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const mint = async (fleetServerId: string): Promise<GsltTokenRow | null> => {
    if (!steam) {
      if (!warnedNoSteam) {
        warnedNoSteam = true
        log.warn(
          'gslt: no Steam key configured (STEAM_WEB_API_KEY) — rented servers will accept ' +
            'LAN connections only; set EZPUG_IRON_STEAM_FAKE_TOKENS=true for a dev pool',
        )
      }
      return null
    }
    const held = (await store.listGsltTokens()).length
    if (held >= max) {
      if (!warnedDry) {
        warnedDry = true
        log.warn(
          `gslt: the pool is dry and at its ceiling of ${max} accounts ` +
            '(EZPUG_IRON_GSLT_POOL_MAX); the next server is LAN-only',
        )
      }
      return null
    }
    const account = await steam.createAccount(memo)
    const row: GsltTokenRow = {
      id: randomUUID(),
      steamId: account.steamId,
      appId: account.appId,
      loginToken: account.loginToken,
      memo: account.memo || memo,
      leasedByServerId: fleetServerId,
      leasedAt: clock.date(),
      lastResetAt: null,
      createdAt: clock.date(),
      deletedAt: null,
    }
    await store.insertGsltToken(row)
    log.info(`gslt: minted account ${account.steamId} (${held + 1}/${max} held)`)
    return row
  }

  /** Point the ledger row at the account it holds, so the row tells the story. */
  const link = async (fleetServerId: string, gsltTokenId: string | null): Promise<void> => {
    try {
      await store.updateServer(fleetServerId, { gsltTokenId })
    } catch (error) {
      // A lease whose ledger row is not there yet (or is already gone) is
      // the sweep's problem, never the allocation's.
      log.warn(`gslt: could not write the lease onto ledger row ${fleetServerId}`)
      void error
    }
  }

  const releaseRow = async (row: GsltTokenRow, lost: boolean): Promise<void> => {
    let loginToken = row.loginToken
    let lastResetAt = row.lastResetAt
    if (lost && steam) {
      try {
        loginToken = await steam.resetLoginToken(row.steamId)
        lastResetAt = clock.date()
        log.info(`gslt: reset the login token of ${row.steamId} after a lost server`)
      } catch (error) {
        // The old token still works, so the account is still worth having;
        // the next sweep tries again through the expiry check.
        log.error(`gslt: resetting the login token of ${row.steamId} failed`, error)
      }
    }
    await store.updateGsltToken(row.id, {
      leasedByServerId: null,
      leasedAt: row.leasedAt,
      loginToken,
      lastResetAt,
    })
  }

  const sweep = async (): Promise<void> => {
    for (const row of await store.listLeakedGsltLeases()) {
      // The row that held it is closed or gone: the server it was on is not
      // running, but nothing proved it stopped — reset before it is reused.
      await releaseRow(row, true)
      log.info(`gslt: freed the lease of ${row.steamId}; its ledger row is closed`)
    }
    if (!steam) return
    let accounts: Awaited<ReturnType<SteamGameServers['listAccounts']>>
    try {
      accounts = await steam.listAccounts()
    } catch (error) {
      log.error('gslt: reading the Steam account list failed', error)
      return
    }
    const byId = new Map(accounts.map(account => [account.steamId, account]))
    for (const row of await store.listGsltTokens()) {
      const account = byId.get(row.steamId)
      if (!account) {
        // Steam does not know it any more (deleted at the website, or on
        // another deployment's sweep): forget it rather than lease a token
        // no server can log in with.
        await store.updateGsltToken(row.id, { deletedAt: clock.date() })
        log.warn(`gslt: account ${row.steamId} is gone from Steam; dropped from the pool`)
        continue
      }
      if (account.expired && row.leasedByServerId === null) {
        try {
          const loginToken = await steam.resetLoginToken(row.steamId)
          await store.updateGsltToken(row.id, { loginToken, lastResetAt: clock.date() })
          log.info(`gslt: account ${row.steamId} had expired; its token was reset`)
        } catch (error) {
          log.error(`gslt: resetting the expired account ${row.steamId} failed`, error)
        }
        continue
      }
      if (account.loginToken !== row.loginToken && row.leasedByServerId === null)
        // Somebody reset it elsewhere; Steam is the truth about a token.
        await store.updateGsltToken(row.id, { loginToken: account.loginToken })
    }
    // Accounts this deployment minted before it lost its database (or before
    // a restore): adopt them rather than mint past the ceiling beside them.
    for (const account of accounts) {
      if (account.memo !== memo) continue
      if (await store.findGsltTokenBySteamId(account.steamId)) continue
      await store.insertGsltToken({
        id: randomUUID(),
        steamId: account.steamId,
        appId: account.appId,
        loginToken: account.loginToken,
        memo: account.memo,
        leasedByServerId: null,
        leasedAt: null,
        lastResetAt: null,
        createdAt: clock.date(),
        deletedAt: null,
      })
      log.info(`gslt: adopted account ${account.steamId}, which carries this deployment's memo`)
    }
  }

  const arm = (): void => {
    timer = clock.after(sweepIntervalMs, () => {
      // On the chain like everything else: a sweep that ran beside a lease
      // would be reading "is this lease leaked" while the lease was being
      // written.
      pass = serial(sweep)
      void pass
        .catch((error: unknown) => log.error('gslt sweep failed', error))
        .finally(() => {
          pass = undefined
          if (running) arm()
        })
    })
  }

  return {
    lease: fleetServerId =>
      serial(async () => {
        const held = await store.findGsltTokenByLease(fleetServerId)
        if (held) return held.loginToken
        const claimed = await store.claimFreeGsltToken(fleetServerId, clock.date())
        const row = claimed ?? (await mint(fleetServerId))
        if (!row) return null
        warnedDry = false
        await link(fleetServerId, row.id)
        return row.loginToken
      }),

    release: (fleetServerId, releaseOptions = {}) =>
      serial(async () => {
        const row = await store.findGsltTokenByLease(fleetServerId)
        if (!row) return
        await releaseRow(row, releaseOptions.lost === true)
        await link(fleetServerId, null)
      }),

    stats: async () => {
      const rows = await store.listGsltTokens()
      return {
        total: rows.length,
        inUse: rows.filter(row => row.leasedByServerId !== null).length,
      }
    },

    sweep: () => serial(sweep),

    start() {
      if (running) return
      running = true
      arm()
    },
    async stop() {
      running = false
      timer?.cancel()
      timer = undefined
      await pass?.catch(() => undefined)
      await chain.catch(() => undefined)
    },
  }
}
