import { randomBytes } from 'node:crypto'
import type { Clock } from '@ezpug/core'
import type { Log } from '../../log'
import type { RandomBytes } from '../../tokens'
import type {
  AllocatedServer,
  AllocationRequest,
  GameServerProvider,
  ProviderConsoleLine,
  ProvisionedServer,
  ServerConfiguration,
  ServerOffering,
  ServerStatus,
} from '../provider'
import type { FetchLike } from './fake'

/**
 * **The Dathost provider** (PRD-02 T16) — the vendor's *raw server API*
 * behind the provider interface. Match.md §3 chose it over Dathost's own
 * match API on purpose: we orchestrate MatchZy ourselves, so a rented box in
 * Frankfurt and a node at the venue are the same thing to everything above
 * here, and our plugin runs on both.
 *
 * **Allocation is a clone of one template.** `scripts/dathost-image.mjs`
 * (T18) builds a single template server — Metamod, CounterStrikeSharp,
 * MatchZy, retakes, our plugins, our cfgs — and
 * `EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID` names it. Allocating is
 * `sync-files` (the vendor's `duplicate` copies the API's *cached* files,
 * not what is on the box — `references/dathost.md`) and then `duplicate`;
 * tearing down is `stop` + `delete`. The template is never started for a
 * match and never deleted by this code: every verb refuses its id outright.
 *
 * **How the interface's verbs map onto the vendor's**, since the PRD writes
 * the whole provisioning as one sentence and the walk splits it in three:
 *
 * - `allocate` — sync the template when stale, `duplicate`, then one `PUT`
 *   that plants our identity on the clone: a readable name, the ledger tag
 *   in `user_data`, `autostop` and `reboot_on_crash` off (the reaper is
 *   ours, and a crash is a `server_lost` we want to see), a **freshly minted
 *   RCON password** so no two servers share the template's, and the GSLT
 *   lease (T17) without which CS2 takes LAN connections only.
 * - `configure` — the two facts that only exist once the walk has minted
 *   them: the join password (`cs2_settings.password`) and `ezpug.json`, the
 *   sidecar carrying the link URL and this server's token, uploaded through
 *   the files API. Nothing else is written: the assignment — gamemode,
 *   plugins, cfg, cvars, roster — travels over the link the plugin dials
 *   (decision 5), never through this door.
 * - `start` — `POST …/start`, and the boot is the walk's boot deadline.
 *
 * **What this provider does not touch.** `cs2_settings.slots` is the
 * template's: on a pay-as-you-go account the slot count is part of the
 * price, and the ledger snapshots `cost_per_hour` at allocate, so a clone
 * that quietly re-prices itself would make the budget a fiction. GOTV is the
 * template's too — this reads `enable_gotv` and reports the relay, it never
 * turns one on.
 *
 * **Retries are not uniform.** A 429 refused the call, so anything may be
 * sent again; a 5xx or a dropped socket may mean the work happened anyway,
 * so only calls that are safe to repeat (`GET`, `start`, `stop`, `sync-files`,
 * a settings `PUT`, a file upload) are retried on one. `duplicate` is not:
 * a retried clone is a second server nobody is billing for. The safety net
 * for the clone whose `PUT` never landed is {@link GameServerProvider.list},
 * which claims a server by its `user_data` tag **or** by
 * `duplicate_source_server` pointing at our template — so a clone is ours
 * from the instant it exists, and the reaper takes it after the grace window.
 *
 * **Secrets.** The Basic-auth header is built once and never logged, never
 * put in an error, never in `provider_meta`. The RCON password is minted per
 * allocation and lives in this process's memory only: nothing downstream
 * needs it (the console door below is Dathost's own, not RCON), and a
 * restart forgetting it costs nothing but a password nobody knows.
 */

export const DATHOST_PROVIDER_ID = 'dathost'

/** The vendor's base URL, `references/dathost.md`. */
export const DATHOST_API_BASE_URL = 'https://dathost.net/api/0.1'

/** Frankfurt, as Dathost spells it (`server-locations-mapping.md`). */
export const DATHOST_DEFAULT_LOCATION = 'dusseldorf'

/** The region label an offering wears for a location id — what a request asks for. */
export const DATHOST_LOCATION_REGIONS: Readonly<Record<string, string>> = {
  dusseldorf: 'frankfurt',
}

/** The GOTV delay a Dathost server states, matching the template's `tv_delay`. */
export const DATHOST_TV_DELAY_SECONDS = 90

/**
 * Where the sidecar goes. Dathost's file paths start at the game root as the
 * control panel shows it — `cfg/server.cfg`, `addons/…` — which for CS2 is
 * `game/csgo`, the very directory the plugin reads `ezpug.json` from
 * (`plugins/README.md`, `EZPug.Core.ServerPaths`). T19's live smoke is where
 * the real file manager gets to disagree; `sidecarPath` is the knob if it does.
 */
export const DATHOST_SIDECAR_PATH = 'ezpug.json'

/** The default `user_data` marker. One deployment, one tag — dev must not reap production. */
export const DATHOST_DEFAULT_TAG = 'ezpug'

/** How long the template's price and capabilities are believed before it is read again. */
export const DATHOST_OFFERINGS_TTL_MS = 60_000

/** How long a `sync-files` on the template counts as fresh enough to clone from. */
export const DATHOST_TEMPLATE_SYNC_TTL_MS = 10 * 60_000

/** How long one request may take before it is aborted — on the injected clock. */
export const DATHOST_REQUEST_TIMEOUT_MS = 30_000

/** Backoff before the second, third and fourth attempt. Four attempts, ~13 s. */
export const DATHOST_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000]

/** The longest a `Retry-After` may push us; a header is a hint, not a hostage. */
export const DATHOST_RETRY_AFTER_MAX_MS = 60_000

/** How many console lines the backlog read asks for. */
export const DATHOST_CONSOLE_LINES = 200

/**
 * The GSLT pool's seam (T17 fills it). Without a Steam Game Server Login
 * Token a CS2 server accepts LAN connections only, which is useless on
 * rented hardware — but the pool, its Steam Web API calls and its table are
 * T17's, so this provider only ever asks for one and gives it back.
 *
 * Leases are keyed by the **Dathost server id**, because "one token per
 * running server" is the vendor's rule and the running server is what a
 * restart can still find.
 */
export interface DathostGsltPool {
  /** A token for this server, or `null` when the pool is empty (LAN only, said out loud). */
  lease: (serverId: string) => Promise<string | null>
  /** Give the lease back. Idempotent — a server with no lease releases successfully. */
  release: (serverId: string) => Promise<void>
}

export interface DathostProviderOptions {
  /** The account's login email — Basic auth, process environment only. */
  email: string
  /** The account's password. Never logged, never in an error, never in `provider_meta`. */
  password: string
  /** The server every match is cloned from. Refused by every verb: it is never a match's server. */
  templateServerId: string
  clock: Clock
  /** The door. Defaults to the global `fetch`; a test hands it the fake Dathost's (T15). */
  fetch?: FetchLike
  /** Defaults to {@link DATHOST_API_BASE_URL}. A test's `listen()` URL goes here. */
  baseUrl?: string
  /** Where clones are created. Defaults to {@link DATHOST_DEFAULT_LOCATION}. */
  location?: string
  /** The region label the offering wears. Defaults to the location's, else the location id. */
  region?: string
  log?: Log
  /** T17's pool. Absent: no token is set and the server is LAN-only, warned about once. */
  gslt?: DathostGsltPool
  /** The bytes behind the per-allocation RCON password; a test pins them. */
  random?: RandomBytes
  /** What GOTV delay the relay is reported with. Default {@link DATHOST_TV_DELAY_SECONDS}. */
  tvDelaySeconds?: number
  /** The `user_data` marker. Default {@link DATHOST_DEFAULT_TAG}. */
  tag?: string
  /** Where `ezpug.json` is uploaded. Default {@link DATHOST_SIDECAR_PATH}. */
  sidecarPath?: string
  offeringsTtlMs?: number
  templateSyncTtlMs?: number
  requestTimeoutMs?: number
  retryDelaysMs?: readonly number[]
}

/** A refusal or a broken transport, with enough to act on and no secret in it. */
export class DathostError extends Error {
  override readonly name = 'DathostError'
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number | null,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

/** The vendor's server object, as much of it as this adapter reads. */
interface DathostServer {
  id: string
  name?: string
  game?: string
  location?: string
  ip?: string
  raw_ip?: string
  on?: boolean
  booting?: boolean
  players_online?: number
  cost_per_hour?: number
  user_data?: string
  duplicate_source_server?: string
  deletion_protection?: boolean
  ports?: { game?: number; gotv?: number; gotv_secondary?: number }
  cs2_settings?: { enable_gotv?: boolean; slots?: number }
}

/** What this process remembers about a clone it made. Memory only — see the module note. */
interface AllocationRecord {
  matchId: string
  fleetServerId: string
  /** Minted per allocation, set on the clone, never stored and never logged. */
  rconPassword: string
  /** True once `start` was sent — the one thing `status` cannot read off the vendor. */
  started: boolean
}

/** The `user_data` tag: which deployment owns a server, and which row it belongs to. */
interface DathostTag {
  tag: string
  matchId?: string
  fleetServerId?: string
}

/** Cents per hour from the vendor's decimal euros — the ledger's integer. */
export function hourlyCentsOf(costPerHour: number | undefined): number {
  if (costPerHour === undefined || !Number.isFinite(costPerHour) || costPerHour < 0) return 0
  return Math.round(costPerHour * 100)
}

/** The region an offering wears for a location: the mapping's, else the location itself. */
export function regionOfLocation(location: string): string {
  return DATHOST_LOCATION_REGIONS[location] ?? location
}

/** What goes into `user_data` — small, greppable, and parsed back by `list`. */
export function encodeTag(tag: DathostTag): string {
  return JSON.stringify({
    tag: tag.tag,
    ...(tag.matchId !== undefined && { matchId: tag.matchId }),
    ...(tag.fleetServerId !== undefined && { fleetServerId: tag.fleetServerId }),
  })
}

/** `user_data` back, or `null` for anything that is not one of ours. */
export function decodeTag(userData: string | undefined): DathostTag | null {
  if (!userData) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(userData)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.tag !== 'string') return null
  return {
    tag: record.tag,
    ...(typeof record.matchId === 'string' && { matchId: record.matchId }),
    ...(typeof record.fleetServerId === 'string' && { fleetServerId: record.fleetServerId }),
  }
}

/** A 429 refused the call; a 5xx may have done the work. Both are weather, not a verdict. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** `Retry-After` in seconds, where the vendor sends one; capped, undocumented, honoured. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(seconds * 1000, DATHOST_RETRY_AFTER_MAX_MS)
}

export function createDathostProvider(options: DathostProviderOptions): GameServerProvider {
  const { clock, email, password, templateServerId } = options
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike)
  const baseUrl = (options.baseUrl ?? DATHOST_API_BASE_URL).replace(/\/+$/, '')
  const location = options.location ?? DATHOST_DEFAULT_LOCATION
  const region = options.region ?? regionOfLocation(location)
  const tag = options.tag ?? DATHOST_DEFAULT_TAG
  const sidecarPath = options.sidecarPath ?? DATHOST_SIDECAR_PATH
  const tvDelaySeconds = options.tvDelaySeconds ?? DATHOST_TV_DELAY_SECONDS
  const offeringsTtlMs = options.offeringsTtlMs ?? DATHOST_OFFERINGS_TTL_MS
  const templateSyncTtlMs = options.templateSyncTtlMs ?? DATHOST_TEMPLATE_SYNC_TTL_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DATHOST_REQUEST_TIMEOUT_MS
  const retryDelaysMs = options.retryDelaysMs ?? DATHOST_RETRY_DELAYS_MS
  const log = options.log

  // Built once, held in this closure, and put on a request by `call` alone.
  const authorization = `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`

  const records = new Map<string, AllocationRecord>()
  let cachedOffering: { at: number; offering: ServerOffering } | undefined
  let templateSyncedAt: number | undefined
  let warnedAboutGslt = false

  /** The one thing this adapter must never do to the template. */
  const assertNotTemplate = (serverId: string, verb: string): void => {
    if (serverId === templateServerId)
      throw new DathostError(
        verb,
        `/game-servers/${serverId}`,
        null,
        `dathost: ${verb} refused on the template server — it is the image, never a match's server`,
      )
  }

  interface CallOptions {
    /** Multipart fields; `undefined` values are left out entirely. */
    form?: Record<string, string | undefined>
    /** One uploaded file, for the files API. */
    file?: { content: string }
    query?: Record<string, string | number | undefined>
    /** Safe to send again after a 5xx or a dropped socket. */
    idempotent?: boolean
    /** A 404 answers `null` instead of throwing — the idempotent teardown. */
    allowMissing?: boolean
  }

  /** One attempt: the header, the body, and a timeout armed on the clock. */
  const attempt = async (method: string, path: string, init: CallOptions): Promise<Response> => {
    const url = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(init.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value))

    let body: FormData | undefined
    if (init.form || init.file) {
      body = new FormData()
      for (const [key, value] of Object.entries(init.form ?? {}))
        if (value !== undefined) body.append(key, value)
      if (init.file) body.append('file', new Blob([init.file.content]), 'file')
    }

    const controller = new AbortController()
    const timeout = clock.after(requestTimeoutMs, () => {
      controller.abort(
        new DathostError(
          method,
          path,
          null,
          `dathost: ${method} ${path} did not answer within ${requestTimeoutMs} ms`,
        ),
      )
    })
    try {
      return await fetchImpl(url.toString(), {
        method,
        headers: { authorization, accept: 'application/json' },
        ...(body && { body }),
        signal: controller.signal,
      })
    } finally {
      timeout.cancel()
    }
  }

  /**
   * A call with the retry policy the module note describes. Answers the
   * `Response` on success, `null` on a 404 the caller allowed, and throws a
   * {@link DathostError} otherwise — with the status and the path in it and
   * nothing else, because everything else on a Dathost request is a secret.
   */
  const send = async (
    method: string,
    path: string,
    init: CallOptions = {},
  ): Promise<Response | null> => {
    const maxAttempts = retryDelaysMs.length + 1
    for (let round = 1; ; round += 1) {
      let response: Response | null = null
      let failure: unknown
      try {
        response = await attempt(method, path, init)
      } catch (error) {
        failure = error
      }

      if (response) {
        if (response.ok) return response
        if (response.status === 404 && init.allowMissing) return null
        const retryable =
          round < maxAttempts &&
          isRetryableStatus(response.status) &&
          (response.status === 429 || init.idempotent === true)
        if (!retryable)
          throw new DathostError(
            method,
            path,
            response.status,
            `dathost: ${method} ${path} answered ${response.status}`,
          )
        const delay = retryAfterMs(response) ?? retryDelaysMs[round - 1] ?? 0
        log?.warn(
          `dathost: ${method} ${path} answered ${response.status}; retrying in ${delay} ms (attempt ${round + 1}/${maxAttempts})`,
        )
        await clock.sleep(delay)
        continue
      }

      // A broken transport. Only a call that may be repeated safely is.
      if (round >= maxAttempts || init.idempotent !== true)
        throw failure instanceof DathostError
          ? failure
          : new DathostError(
              method,
              path,
              null,
              `dathost: ${method} ${path} failed (${errorText(failure)})`,
              failure,
            )
      const delay = retryDelaysMs[round - 1] ?? 0
      log?.warn(
        `dathost: ${method} ${path} failed (${errorText(failure)}); retrying in ${delay} ms (attempt ${round + 1}/${maxAttempts})`,
      )
      await clock.sleep(delay)
    }
  }

  const json = async <T>(response: Response, method: string, path: string): Promise<T> => {
    try {
      return (await response.json()) as T
    } catch (error) {
      throw new DathostError(
        method,
        path,
        response.status,
        `dathost: ${method} ${path} answered ${response.status} with a body that is not JSON`,
        error,
      )
    }
  }

  /** `send` where the answer is a body: a 404 the caller allowed is `null`. */
  const sendJson = async <T>(
    method: string,
    path: string,
    init: CallOptions = {},
  ): Promise<T | null> => {
    const response = await send(method, path, init)
    return response === null ? null : await json<T>(response, method, path)
  }

  /** `GET /game-servers/{id}` — the single read, the one that refreshes `booting`. */
  const getServer = async (serverId: string): Promise<DathostServer | null> => {
    return await sendJson<DathostServer>('GET', `/game-servers/${encodeURIComponent(serverId)}`, {
      idempotent: true,
      allowMissing: true,
    })
  }

  const connectOf = (server: DathostServer): AllocatedServer['connect'] => {
    const host = server.ip ?? server.raw_ip
    const port = server.ports?.game
    return host && port ? { host, port } : undefined
  }

  const tvOf = (server: DathostServer): AllocatedServer['tv'] => {
    const host = server.ip ?? server.raw_ip
    const port = server.ports?.gotv
    if (!host || !port || server.cs2_settings?.enable_gotv !== true) return undefined
    return { host, port, delaySeconds: tvDelaySeconds }
  }

  /** The template, read at most once per {@link DATHOST_OFFERINGS_TTL_MS}. */
  const readTemplate = async (): Promise<DathostServer> => {
    const server = await getServer(templateServerId)
    if (!server)
      throw new DathostError(
        'GET',
        `/game-servers/${templateServerId}`,
        404,
        `dathost: the template server ${templateServerId} is not on this account ` +
          '(EZPUG_IRON_DATHOST_TEMPLATE_SERVER_ID; build one with scripts/dathost-image.mjs)',
      )
    return server
  }

  /**
   * `duplicate` copies the API's cached files. The template is never started,
   * so its cache only goes stale when the image script uploads something —
   * syncing on a TTL costs one call per window and makes "the clone runs
   * yesterday's plugin" impossible to reach by forgetting.
   */
  const syncTemplateIfStale = async (): Promise<void> => {
    if (templateSyncedAt !== undefined && clock.now() - templateSyncedAt < templateSyncTtlMs) return
    await send('POST', `/game-servers/${encodeURIComponent(templateServerId)}/sync-files`, {
      idempotent: true,
    })
    templateSyncedAt = clock.now()
  }

  /** Stop and delete, for a clone that must not survive. Never throws. */
  const scrap = async (serverId: string, why: string): Promise<void> => {
    try {
      await send('POST', `/game-servers/${encodeURIComponent(serverId)}/stop`, {
        idempotent: true,
        allowMissing: true,
      })
    } catch (error) {
      log?.error(`dathost: stopping ${serverId} while ${why} failed`, error)
    }
    try {
      await send('DELETE', `/game-servers/${encodeURIComponent(serverId)}`, {
        idempotent: true,
        allowMissing: true,
      })
      records.delete(serverId)
      await options.gslt?.release(serverId)
    } catch (error) {
      // The reaper holds the rest: the clone carries our template as its
      // `duplicate_source_server`, so `list()` claims it and the next pass
      // deallocates it again.
      log?.error(`dathost: deleting ${serverId} while ${why} failed; left to the reaper`, error)
    }
  }

  const mintRconPassword = (): string =>
    (options.random ?? randomBytes)(12).toString('base64url').slice(0, 16)

  return {
    id: DATHOST_PROVIDER_ID,

    /**
     * One offering: what the template says a clone of it costs and can do.
     * Cloud capacity is unbounded as far as this adapter knows — the wall is
     * the API key's budget (T5), not a number Dathost publishes.
     */
    async offerings(): Promise<ServerOffering[]> {
      const cached = cachedOffering
      if (cached && clock.now() - cached.at < offeringsTtlMs) return [cached.offering]
      const template = await readTemplate()
      const offering: ServerOffering = {
        capabilities: {
          games: ['cs2'],
          region,
          tickrate: 128,
          lan: false,
          // Dathost serves workshop maps through `cs2_settings.workshop_*`
          // and the plugin's `host_workshop_map` (api-added-cs2-workshop-support).
          workshopMaps: true,
        },
        hourlyCents: hourlyCentsOf(template.cost_per_hour),
      }
      cachedOffering = { at: clock.now(), offering }
      return [offering]
    },

    async allocate(request: AllocationRequest): Promise<AllocatedServer> {
      await syncTemplateIfStale()

      const duplicatePath = `/game-servers/${encodeURIComponent(templateServerId)}/duplicate`
      // **Not** idempotent: a retried clone is a second server on the bill.
      const clone = (await sendJson<DathostServer>('POST', duplicatePath, {
        form: { location },
      })) as DathostServer
      const serverId = String(clone.id)

      try {
        const gslt = (await options.gslt?.lease(serverId)) ?? null
        if (!gslt && !warnedAboutGslt) {
          warnedAboutGslt = true
          log?.warn(
            'dathost: no GSLT lease — the server will accept LAN connections only (T17 mints the pool)',
          )
        }
        const rconPassword = mintRconPassword()
        await send('PUT', `/game-servers/${encodeURIComponent(serverId)}`, {
          idempotent: true,
          form: {
            name: `ezpug ${request.matchId.slice(0, 8)} ${request.requirements.game}`,
            user_data: encodeTag({
              tag,
              matchId: request.matchId,
              fleetServerId: request.fleetServerId,
            }),
            // The reaper is ours and a crash is a loss we want to see.
            autostop: 'false',
            reboot_on_crash: 'false',
            'cs2_settings.rcon': rconPassword,
            ...(gslt && { 'cs2_settings.steam_game_server_login_token': gslt }),
          },
        })
        records.set(serverId, {
          matchId: request.matchId,
          fleetServerId: request.fleetServerId,
          rconPassword,
          started: false,
        })
        return {
          serverId,
          ...(connectOf(clone) && { connect: connectOf(clone) }),
          ...(tvOf(clone) && { tv: tvOf(clone) }),
          meta: {
            location: clone.location ?? location,
            clonedFrom: templateServerId,
            costPerHour: clone.cost_per_hour ?? null,
          },
        }
      } catch (error) {
        // Half an allocation is a server nobody will ever use and everybody
        // pays for: take it back before the walk moves to the next candidate.
        await scrap(serverId, 'an allocation that failed half-way')
        throw error
      }
    },

    async configure(serverId: string, configuration: ServerConfiguration): Promise<void> {
      assertNotTemplate(serverId, 'configure')
      await send('PUT', `/game-servers/${encodeURIComponent(serverId)}`, {
        idempotent: true,
        form: { 'cs2_settings.password': configuration.joinPassword },
      })
      // Where home is (`EZPug.Sdk.Sidecar`): the link URL and this server's
      // token, nothing else. The assignment itself comes down the link.
      await send(
        'POST',
        `/game-servers/${encodeURIComponent(serverId)}/files/${encodeURIComponent(sidecarPath)}`,
        {
          idempotent: true,
          file: {
            content: `${JSON.stringify(
              { url: configuration.link.url, token: configuration.link.serverToken },
              null,
              2,
            )}\n`,
          },
        },
      )
    },

    async start(serverId: string): Promise<void> {
      assertNotTemplate(serverId, 'start')
      await send('POST', `/game-servers/${encodeURIComponent(serverId)}/start`, {
        idempotent: true,
      })
      const record = records.get(serverId)
      if (record) record.started = true
    },

    async stop(serverId: string): Promise<void> {
      assertNotTemplate(serverId, 'stop')
      await send('POST', `/game-servers/${encodeURIComponent(serverId)}/stop`, {
        idempotent: true,
        allowMissing: true,
      })
    },

    /**
     * One `GET`, because the list does not refresh `booting`
     * (`references/dathost.md`). A server that is off is **stopped** — during
     * a match that is exactly the loss the probe is looking for — except in
     * the one window this process knows better: between `allocate` and
     * `start`, where a clone is off because nobody has started it yet.
     */
    async status(serverId: string): Promise<ServerStatus> {
      const server = await getServer(serverId)
      if (!server) return { state: 'gone' }
      const record = records.get(serverId)
      const state: ServerStatus['state'] = server.booting
        ? 'starting'
        : server.on
          ? 'running'
          : record && !record.started
            ? 'allocated'
            : 'stopped'
      const connect = connectOf(server)
      const tv = tvOf(server)
      return {
        state,
        ...(connect && { connect }),
        ...(tv && { tv }),
        ...(server.players_online !== undefined && { playerCount: server.players_online }),
      }
    },

    /** Stop, delete, release the lease. Idempotent: a server already gone is a success. */
    async deallocate(serverId: string): Promise<void> {
      assertNotTemplate(serverId, 'deallocate')
      try {
        await send('POST', `/game-servers/${encodeURIComponent(serverId)}/stop`, {
          idempotent: true,
          allowMissing: true,
        })
      } catch (error) {
        // A box that will not stop is still a box that must be deleted.
        log?.warn(`dathost: stopping ${serverId} before deletion failed (${errorText(error)})`)
      }
      await send('DELETE', `/game-servers/${encodeURIComponent(serverId)}`, {
        idempotent: true,
        allowMissing: true,
      })
      records.delete(serverId)
      await options.gslt?.release(serverId)
    },

    /**
     * Provider-side reality: every server on the account that is ours. Two
     * claims, because the first has a window the second closes — a clone
     * exists before the `PUT` that tags it, and `duplicate_source_server`
     * names our template from the instant it is created. A server wearing
     * *another* deployment's tag is never claimed by the second rule: two
     * orchestrators may share an account, and a reaper that deleted the
     * other one's live match would be worse than a leak. (They should not
     * share a *template* — an untagged clone is ambiguous for as long as it
     * takes the other one's `PUT` to land.)
     */
    async list(): Promise<ProvisionedServer[]> {
      const path = '/game-servers'
      const servers = (await sendJson<DathostServer[]>('GET', path, {
        idempotent: true,
      })) as DathostServer[]
      const ours: ProvisionedServer[] = []
      for (const server of servers) {
        const id = String(server.id)
        if (id === templateServerId) continue
        const parsed = decodeTag(server.user_data)
        if (parsed !== null && parsed.tag !== tag) continue
        const tagged = parsed !== null
        if (!tagged && server.duplicate_source_server !== templateServerId) continue
        ours.push({
          serverId: id,
          ...(parsed?.matchId !== undefined && { matchId: parsed.matchId }),
          ...(parsed?.fleetServerId !== undefined && { fleetServerId: parsed.fleetServerId }),
        })
      }
      return ours
    },

    /** `say` down the vendor's console — the operator's line before the link is up. */
    async announce(serverId: string, line: string): Promise<boolean> {
      assertNotTemplate(serverId, 'announce')
      const response = await send('POST', `/game-servers/${encodeURIComponent(serverId)}/console`, {
        form: { line: `say ${line}` },
        allowMissing: true,
      })
      return response !== null
    },

    /**
     * The RCON fallback (T20 owns the route). Dathost's console is a *log*,
     * not a request/response channel: the command goes in with `POST` and
     * whatever the game printed comes back on the next backlog read, so this
     * answers the lines that appeared after ours. Best effort, and honest
     * about it — the link is where a command gets a real result.
     */
    async rcon(serverId: string, command: string): Promise<string | null> {
      assertNotTemplate(serverId, 'rcon')
      const consolePath = `/game-servers/${encodeURIComponent(serverId)}/console`
      const before = await send('GET', consolePath, {
        idempotent: true,
        allowMissing: true,
        query: { max_lines: DATHOST_CONSOLE_LINES },
      })
      if (!before) return null
      const backlog = (await json<{ lines?: string[] }>(before, 'GET', consolePath)).lines ?? []
      const sent = await send('POST', consolePath, { form: { line: command }, allowMissing: true })
      if (!sent) return null
      const after = await send('GET', consolePath, {
        idempotent: true,
        allowMissing: true,
        query: { max_lines: DATHOST_CONSOLE_LINES },
      })
      if (!after) return null
      const lines = (await json<{ lines?: string[] }>(after, 'GET', consolePath)).lines ?? []
      // The line we sent is echoed by the console; the answer is what follows it.
      const fresh = lines.slice(backlog.length).filter(line => line !== command)
      return fresh.join('\n')
    },

    /** The backlog Dathost holds, for the fleet console route before the link is up. */
    async console(serverId: string): Promise<ProviderConsoleLine[] | null> {
      const path = `/game-servers/${encodeURIComponent(serverId)}/console`
      const response = await send('GET', path, {
        idempotent: true,
        allowMissing: true,
        query: { max_lines: DATHOST_CONSOLE_LINES },
      })
      if (!response) return null
      const lines = (await json<{ lines?: string[] }>(response, 'GET', path)).lines ?? []
      // Dathost's backlog carries no timestamps; the read's own instant is
      // the only honest one, and it is the clock's.
      const at = clock.date().toISOString()
      return lines.map(line => ({ at, line }))
    },
  }
}

/** The message of anything thrown, without dragging a stack into a log line. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
