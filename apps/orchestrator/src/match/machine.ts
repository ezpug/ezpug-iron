import { createHash, randomUUID } from 'node:crypto'
import type { Clock, Timer } from '@ezpug/core'
import type {
  GamemodeManifest,
  GameserverEvent,
  GameserverPlayer,
  Match,
  MatchApiErrorCode,
  MatchCommand,
  MatchCommandResult,
  MatchEndedReason,
  MatchListFilter,
  MatchRequest,
  MatchState,
  RosterEntry,
  WebhookEnvelope,
  WebhookPayload,
} from '@ezpug/match-api'
import {
  ApiError,
  gamemodeAllowsMap,
  isSimCommand,
  isTerminalMatchState,
  MATCH_API_ERROR_STATUS,
  STREAM_CLOSE_CODES,
} from '@ezpug/match-api'
import {
  HEARTBEAT_INTERVAL_MS_DEFAULT,
  type OrchestratorFrameOf,
  SERVER_LINK_PATH,
} from '@ezpug/protocol'
import { SIM_PROVIDER_ID } from '@ezpug/sim'
import type { BudgetGate } from '../budget/service'
import type { AuthenticatedKey } from '../keys/service'
import { composeAssign, missingPlugins } from '../link/assign'
import type { IngestStatus, LinkRegistry, ServerEventSink, ServerRef } from '../link/channels'
import { serverKey } from '../link/channels'
import type { Log } from '../log'
import type { ProviderRegistry } from '../providers/registry'
import type { AllocationCandidate } from '../providers/selection'
import { selectCandidates } from '../providers/selection'
import { SimPlanError, simPlanFor } from '../providers/sim/provider'
import type { StreamHub } from '../stream/hub'
import { hashToken, mintToken, type RandomBytes } from '../tokens'
import type { MatchRow, MatchStore, ServerRow } from './store'
import { envelopeOf, matchView } from './views'

/**
 * **The match machine** (PRD-02 T3): `pending → allocating → configuring →
 * ready → live → ended | failed | cancelled`, `recovering` from `live`.
 * Everything about one match runs on **that match's chain**, one step at a
 * time, in the order it was asked — a server's event, a command, a cancel,
 * a deadline — so the durable log's order never depends on how the clock
 * was advanced or which socket answered first (the fake's rule, made real).
 *
 * Every wait is a **deadline on the clock**, armed from the moment the state
 * was entered (`state_changed_at`) so a restart re-arms it at the same
 * absolute instant (`resume()`):
 *
 * - `allocate` — from `allocating`; expiry fails `allocation_failed`.
 * - `boot` — from `configuring` until `server_ready`; expiry fails
 *   `provider_error`.
 * - `join` — from `ready` until `going_live`; expiry ends `ttl_expired`.
 * - `recovery` — the `server_lost` window; expiry fails `server_lost`.
 * - `ttl` — the request's `ttlMinutes`; expiry ends `ttl_expired`.
 * - the **loss detector** — no event from the server for a few heartbeat
 *   intervals and the provider is probed; `gone` opens `recovering` (or
 *   fails the match before it was live).
 *
 * The provisioning walk (`provision`) is the platform's, ported: a ledger
 * row *before* the provider is asked, the next candidate on any failure,
 * `deallocateQuietly` for what a failed candidate left behind, and only an
 * exhausted list fails the match. The reaper (`../providers/reaper.ts`)
 * holds provider truth against the rows this writes.
 *
 * Events arrive through {@link ServerEventSink} — from the sim provider in
 * process, from a real plugin over `/link` (`../link/server-link.ts`, which
 * also asks here for the assignment on `hello` and re-arms the loss detector
 * on a heartbeat) — and are deduplicated per server `seq`, logged as
 * envelopes (`emit`), mirrored to the stream and handed to the webhook
 * worker. Recovery onto a new server with a backup
 * (`assign.restore`) is T14's; here a lost server with no backup fails the
 * match honestly and one with a backup waits the window.
 */

export interface MatchDeadlines {
  /** From `allocating` to `configuring`. */
  allocateMs: number
  /** From `configuring` to `server_ready`. */
  bootMs: number
  /** From `ready` to `going_live`. */
  joinMs: number
  /** The `recovering` window. */
  recoveryMs: number
  /** No event from a live server for this long and it is probed. */
  heartbeatTimeoutMs: number
}

export const DEFAULT_MATCH_DEADLINES: MatchDeadlines = {
  allocateMs: 2 * 60_000,
  bootMs: 5 * 60_000,
  joinMs: 20 * 60_000,
  recoveryMs: 5 * 60_000,
  heartbeatTimeoutMs: 3 * HEARTBEAT_INTERVAL_MS_DEFAULT,
}

export interface MatchesOptions {
  clock: Clock
  log: Log
  store: MatchStore
  providers: ProviderRegistry
  links: LinkRegistry
  gamemodes: readonly GamemodeManifest[]
  hub: StreamHub
  /** The webhook worker's door: a delivery row was written. */
  webhooks: { kick: () => void }
  /** The budget's door: the three ceilings, checked against the ledger (T5). */
  budget: BudgetGate
  /** The orchestrator's own origin — what a server's plugin dials the link at. */
  baseUrl: string
  deadlines?: Partial<MatchDeadlines>
  /** Injectable for a test that pins a password's shape; defaults to the CSPRNG. */
  random?: RandomBytes
  onError?: (error: unknown, context: Record<string, unknown>) => void
}

export interface CreateMatchResult {
  match: Match
  /** True when the same request was seen before and this is its match, not a new one. */
  replayed: boolean
}

export interface Matches extends ServerEventSink {
  create: (key: AuthenticatedKey, request: MatchRequest) => Promise<CreateMatchResult>
  get: (key: AuthenticatedKey, matchId: string) => Promise<Match>
  list: (
    key: AuthenticatedKey,
    filter: MatchListFilter,
    cursor: string | undefined,
    limit: number,
  ) => Promise<{ items: Match[]; nextCursor: string | null }>
  cancel: (key: AuthenticatedKey, matchId: string) => Promise<Match>
  command: (
    key: AuthenticatedKey,
    matchId: string,
    body: MatchCommand,
  ) => Promise<MatchCommandResult>
  events: (
    key: AuthenticatedKey,
    matchId: string,
    afterSeq: number,
    limit: number,
  ) => Promise<{ items: WebhookEnvelope[]; nextCursor: string | null }>
  /** The row of a match this key may see, or `not_found`. */
  require: (key: AuthenticatedKey, matchId: string) => Promise<MatchRow>
  view: (row: MatchRow) => Match
  /** One durable fact into the match's log (the reaper's and the fleet's door). */
  emit: (matchId: string, payload: WebhookPayload) => Promise<WebhookEnvelope | null>
  /** The reaper's alarm: the provider no longer lists this match's server. */
  suspect: (matchId: string, detail: string) => Promise<void>
  /** The link's heartbeat (T6): the server is alive — re-arm the loss detector of its match. */
  touch: (source: ServerRef) => Promise<void>
  /**
   * The link's `hello` (T6): the assignment for the match this server's row
   * holds, composed from the request, the manifest and every profile pushed
   * since; null when the row holds no open match. A manifest naming a plugin
   * the image lacks fails the match `provider_error` here, before anything
   * is sent.
   */
  assignment: (
    source: ServerRef,
    hello: { plugins: readonly string[]; matchId?: string },
  ) => Promise<OrchestratorFrameOf<'assign'> | null>
  /** The reaper's ceiling: the match's ttl ran out. */
  expire: (matchId: string, detail: string) => Promise<void>
  /** `POST /v1/fleet/servers/:id/release`: end the match on this row `provider_error` and deallocate. */
  releaseRow: (row: ServerRow, reason: string | undefined) => Promise<void>
  /** After boot: re-arm every open match's deadlines and restart dead walks. */
  resume: () => Promise<void>
  /** Resolve once every chain and in-flight step has settled. */
  settle: () => Promise<void>
  /** Disarm every timer and wait for the chains. */
  close: () => Promise<void>
}

type TimerName = 'allocate' | 'boot' | 'join' | 'recovery' | 'heartbeat' | 'ttl'

interface Runtime {
  chain: Promise<void>
  timers: Partial<Record<TimerName, Timer>>
  presence: Map<string, GameserverPlayer>
  /** The roster plus every pushed profile — who the server knows. */
  known: Map<string, RosterEntry>
  /** `provider/serverId#seq` of every server event taken — a duplicate is dropped here. */
  seen: Set<string>
  currentMap: number
  paused: boolean
  lastSeenWrittenAt: number
}

const LAST_SEEN_WRITE_INTERVAL_MS = 5_000

function refuse(code: MatchApiErrorCode, message: string, details?: Record<string, unknown>) {
  return new ApiError(MATCH_API_ERROR_STATUS[code], code, message, details)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  return value
}

/** The hash a repeated `clientMatchId` is compared against: the canonical request. */
export function requestHash(request: MatchRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(request)))
    .digest('hex')
}

/** An offset cursor for the paged lists: digits, opaque to the client. */
function page<T>(items: T[], nextOffset: number | null) {
  return { items, nextCursor: nextOffset === null ? null : String(nextOffset) }
}

function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^\d{1,9}$/.test(cursor)) throw refuse('validation_failed', 'the cursor is not one of ours')
  return Number(cursor)
}

export function createMatches(options: MatchesOptions): Matches {
  const { clock, log, store, providers, links, hub, gamemodes } = options
  const deadlines: MatchDeadlines = { ...DEFAULT_MATCH_DEADLINES, ...options.deadlines }
  const report =
    options.onError ??
    ((error: unknown, context: Record<string, unknown>) =>
      log.error(`matches ${String(context.phase ?? 'unknown')}`, error))
  const runtimes = new Map<string, Runtime>()
  const inflight = new Set<Promise<unknown>>()
  /** `provider/serverId` → the match it plays for, filled at allocation and from the ledger. */
  const attribution = new Map<string, string>()
  let closed = false

  const now = (): Date => clock.date()

  // --- the chain ----------------------------------------------------------------

  const track = <T>(promise: Promise<T>): Promise<T> => {
    const tracked = promise.finally(() => {
      inflight.delete(tracked)
    })
    inflight.add(tracked)
    return tracked
  }

  const runtimeOf = (row: MatchRow): Runtime => {
    let runtime = runtimes.get(row.id)
    if (!runtime) {
      runtime = {
        chain: Promise.resolve(),
        timers: {},
        presence: new Map(),
        known: new Map(
          [...row.requestJson.teams.teamA.players, ...row.requestJson.teams.teamB.players].map(
            player => [player.steamId64, player],
          ),
        ),
        seen: new Set(),
        currentMap: 1,
        paused: false,
        lastSeenWrittenAt: 0,
      }
      runtimes.set(row.id, runtime)
    }
    return runtime
  }

  /** Run `step` on the match's chain: after everything queued before it, before everything after. */
  const enqueue = <T>(row: MatchRow, step: (fresh: MatchRow) => T | Promise<T>): Promise<T> => {
    const runtime = runtimeOf(row)
    const result = runtime.chain.then(async () => {
      const fresh = await store.findMatch(row.id)
      if (!fresh) throw new Error(`match ${row.id} vanished`)
      return step(fresh)
    })
    runtime.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return track(result)
  }

  const setTimer = (
    row: MatchRow,
    name: TimerName,
    at: number,
    fire: (fresh: MatchRow) => Promise<void>,
  ) => {
    const runtime = runtimeOf(row)
    runtime.timers[name]?.cancel()
    runtime.timers[name] = clock.at(at, () => {
      runtime.timers[name] = undefined
      void enqueue(row, fire).catch((error: unknown) =>
        report(error, { phase: `deadline:${name}`, matchId: row.id }),
      )
    })
  }

  const cancelTimer = (row: MatchRow, name: TimerName): void => {
    const runtime = runtimes.get(row.id)
    runtime?.timers[name]?.cancel()
    if (runtime) runtime.timers[name] = undefined
  }

  const cancelTimers = (row: MatchRow): void => {
    const runtime = runtimes.get(row.id)
    if (!runtime) return
    for (const timer of Object.values(runtime.timers)) timer?.cancel()
    runtime.timers = {}
  }

  // --- the durable log, the stream, the webhooks ------------------------------------

  /**
   * Write one fact to the durable log, publish it and queue its delivery.
   *
   * `patch` is the state change the fact *announces*, applied to the row in
   * the same transaction as the append: a reader is never allowed to see the
   * new state with the old `seq`, because the events route would then hold an
   * envelope past the last one the client was told about. `matches.get` reads
   * off the match's chain (a poll must not queue behind a provisioning walk),
   * so this atomicity is the only thing standing between the two.
   */
  const emit = async (
    row: MatchRow,
    payload: WebhookPayload,
    patch: Parameters<MatchStore['updateMatch']>[1] = {},
  ): Promise<WebhookEnvelope> => {
    const at = now()
    const event = await store.appendEvent(
      row.id,
      { deliveryId: randomUUID(), type: payload.type, occurredAt: at, payload },
      at,
      patch,
    )
    Object.assign(row, patch)
    row.seq = event.seq
    row.updatedAt = at
    const envelope = envelopeOf(row, event)
    hub.publish(row.id, { type: 'event', envelope })
    if (!row.webhooksStoppedAt) {
      await store.insertDelivery({
        deliveryId: event.deliveryId,
        matchId: row.id,
        seq: event.seq,
        url: row.requestJson.callbacks.webhookUrl,
        secretId: row.requestJson.callbacks.webhookSecretId,
        status: 'pending',
        attempt: 0,
        nextAttemptAt: at,
        lastStatus: null,
        lastError: null,
        deliveredAt: null,
        createdAt: at,
        updatedAt: at,
      })
      options.webhooks.kick()
    }
    return envelope
  }

  const presenceFrame = (row: MatchRow): void => {
    hub.publish(row.id, { type: 'presence', players: [...runtimeOf(row).presence.values()] })
  }

  // --- state ----------------------------------------------------------------------

  const setState = async (
    row: MatchRow,
    state: MatchState,
    extra: Parameters<MatchStore['updateMatch']>[1] = {},
  ) => {
    const at = now()
    const patch = { state, stateChangedAt: at, updatedAt: at, ...extra }
    await store.updateMatch(row.id, patch)
    Object.assign(row, patch)
  }

  const manifestOf = (row: MatchRow): GamemodeManifest => {
    const manifest = gamemodes.find(m => m.id === row.gamemode)
    if (!manifest) throw new Error(`match ${row.id}: no gamemode ${row.gamemode}`)
    return manifest
  }

  const simOf = (row: MatchRow) =>
    (row.provider && row.serverId && providers.get(row.provider)?.sim?.(row.serverId)) || row.sim

  const view = (row: MatchRow): Match => matchView(row, simOf(row))

  const currentServer = async (row: MatchRow): Promise<ServerRow | undefined> =>
    row.fleetServerId ? store.findServer(row.fleetServerId) : undefined

  // --- the ledger ---------------------------------------------------------------------

  const closeRow = async (
    server: ServerRow,
    state: 'released' | 'failed',
    reason: string,
    deallocate: boolean,
  ): Promise<void> => {
    const provider = providers.get(server.provider)
    if (deallocate && provider && server.serverId) {
      // Told over the link before the provider pulls the plug, so a real
      // server unloads its mode and says `state: idle` while it still can.
      const channel = links.get({ provider: server.provider, serverId: server.serverId })
      try {
        await channel?.release?.(reason)
      } catch (error) {
        report(error, { phase: `release:${server.provider}`, serverId: server.serverId })
      }
      try {
        await provider.stop(server.serverId)
      } catch (error) {
        report(error, { phase: `stop:${server.provider}`, serverId: server.serverId })
      }
      try {
        await provider.deallocate(server.serverId)
      } catch (error) {
        // Best effort only: the reaper retries until the deallocate holds.
        report(error, { phase: `deallocate:${server.provider}`, serverId: server.serverId })
      }
      links.detach({ provider: server.provider, serverId: server.serverId })
    }
    if (server.serverId)
      attribution.delete(serverKey({ provider: server.provider, serverId: server.serverId }))
    if (server.releasedAt) return
    await store.updateServer(server.id, {
      state,
      releasedAt: now(),
      releasedReason: reason,
    })
  }

  const deallocateQuietly = async (
    candidate: AllocationCandidate,
    serverId: string,
  ): Promise<void> => {
    try {
      await candidate.provider.deallocate(serverId)
    } catch (error) {
      report(error, { phase: `deallocate:${candidate.provider.id}`, serverId })
    }
  }

  // --- the end --------------------------------------------------------------------------

  const end = async (
    row: MatchRow,
    state: 'ended' | 'failed' | 'cancelled',
    reason: MatchEndedReason,
    rowState: 'released' | 'failed',
  ): Promise<void> => {
    if (isTerminalMatchState(row.state)) return
    cancelTimers(row)
    const sim = simOf(row)
    const server = await currentServer(row)
    if (server) await closeRow(server, rowState, `${state}: ${reason.kind}`, true)
    // The terminal state and the fact that announces it are one write.
    const at = now()
    const patch = {
      state,
      stateChangedAt: at,
      updatedAt: at,
      endedAt: at,
      endedReason: reason,
      sim,
    }
    if (state === 'failed') await emit(row, { type: 'match.failed', state, reason }, patch)
    else await emit(row, { type: 'match.ended', state, reason }, patch)
    hub.closeMatch(row.id, STREAM_CLOSE_CODES.matchEnded)
    runtimes.delete(row.id)
  }

  const fail = (row: MatchRow, kind: MatchEndedReason['kind'], detail: string) =>
    end(row, 'failed', { kind, detail }, 'failed')

  // --- deadlines ----------------------------------------------------------------------------

  const armTtl = (row: MatchRow): void =>
    setTimer(row, 'ttl', row.expiresAt.getTime(), fresh =>
      end(
        fresh,
        'ended',
        { kind: 'ttl_expired', detail: `ttlMinutes ${fresh.requestJson.ttlMinutes} ran out` },
        'released',
      ),
    )

  const armAllocate = (row: MatchRow): void =>
    setTimer(row, 'allocate', row.stateChangedAt.getTime() + deadlines.allocateMs, fresh =>
      fresh.state === 'allocating'
        ? fail(fresh, 'allocation_failed', `no server within ${deadlines.allocateMs} ms`)
        : Promise.resolve(),
    )

  const armBoot = (row: MatchRow): void =>
    setTimer(row, 'boot', row.stateChangedAt.getTime() + deadlines.bootMs, fresh =>
      fresh.state === 'configuring'
        ? fail(fresh, 'provider_error', `no server_ready within ${deadlines.bootMs} ms`)
        : Promise.resolve(),
    )

  const armJoin = (row: MatchRow): void =>
    setTimer(row, 'join', row.stateChangedAt.getTime() + deadlines.joinMs, fresh =>
      fresh.state === 'ready'
        ? end(
            fresh,
            'ended',
            { kind: 'ttl_expired', detail: `no going_live within ${deadlines.joinMs} ms of ready` },
            'released',
          )
        : Promise.resolve(),
    )

  const armRecovery = (row: MatchRow): void =>
    setTimer(row, 'recovery', row.stateChangedAt.getTime() + deadlines.recoveryMs, fresh =>
      fresh.state === 'recovering'
        ? fail(fresh, 'server_lost', 'recovery window expired')
        : Promise.resolve(),
    )

  /**
   * The loss detector: no event from the server for `heartbeatTimeoutMs`
   * and the provider is probed. Suspended while a pause parks the server.
   */
  const armHeartbeat = (row: MatchRow): void => {
    const runtime = runtimeOf(row)
    if (runtime.paused) return
    setTimer(row, 'heartbeat', clock.now() + deadlines.heartbeatTimeoutMs, fresh => probe(fresh))
  }

  const probe = async (row: MatchRow): Promise<void> => {
    if (row.state !== 'ready' && row.state !== 'live' && row.state !== 'configuring') return
    const server = await currentServer(row)
    const provider = row.provider ? providers.get(row.provider) : undefined
    if (!server?.serverId || !provider) return
    let state: string
    try {
      state = (await provider.status(server.serverId)).state
    } catch (error) {
      // A provider API that is down is not a dead gameserver. Report and try
      // again next window — the match's own deadlines are the floor.
      report(error, { phase: `probe:${row.provider}`, matchId: row.id })
      armHeartbeat(row)
      return
    }
    if (state === 'gone' || state === 'stopped') {
      await lost(
        row,
        `silent for ${deadlines.heartbeatTimeoutMs} ms; ${row.provider} reports the server ${state}`,
      )
      return
    }
    // Up and merely quiet — keep listening.
    armHeartbeat(row)
  }

  /** The server is gone. Before `live` the match fails; from `live` the window opens. */
  const lost = async (row: MatchRow, reason: string): Promise<void> => {
    if (isTerminalMatchState(row.state) || row.state === 'recovering') return
    if (row.state !== 'live') {
      await fail(row, 'provider_error', `server lost before going live: ${reason}`)
      return
    }
    cancelTimer(row, 'heartbeat')
    const backup = await store.latestBackup(row.id)
    await emit(row, {
      type: 'match.recovering',
      reason: reason.slice(0, 256),
      backupRound: backup?.roundNumber ?? null,
    })
    await setState(row, 'recovering')
    const server = await currentServer(row)
    if (server) await closeRow(server, 'failed', `server lost: ${reason}`, true)
    if (!backup) {
      await fail(row, 'server_lost', 'no backup to restore from')
      return
    }
    // T14 resumes the walk from here with `assign.restore`; until then the
    // window is honest about what it can do.
    armRecovery(row)
  }

  // --- the provisioning walk ----------------------------------------------------------------

  const provision = async (row: MatchRow): Promise<void> => {
    if (row.state !== 'pending' && row.state !== 'allocating') return
    if (row.state === 'pending') await setState(row, 'allocating')
    armAllocate(row)
    const request = row.requestJson
    const manifest = manifestOf(row)
    const selection = await selectCandidates(providers, request, { now: () => now().toISOString() })
    for (const failure of selection.failures)
      report(failure.error, { phase: `offerings:${failure.provider}`, matchId: row.id })

    for (const candidate of selection.candidates) {
      if (clock.now() >= row.stateChangedAt.getTime() + deadlines.allocateMs) break
      const { provider, offering } = candidate
      const fleetServerId = randomUUID()
      const at = now()
      await store.insertServer({
        id: fleetServerId,
        provider: provider.id,
        serverId: null,
        nodeId: null,
        matchId: row.id,
        keyId: row.keyId,
        state: 'allocated',
        game: row.game,
        region: offering.capabilities.region,
        lan: offering.capabilities.lan,
        address: null,
        tv: null,
        costHourlyCents: offering.hourlyCents,
        providerMeta: null,
        versions: null,
        hostname: null,
        currentMap: null,
        linkState: null,
        linkAckedSeq: 0,
        lastSeenAt: null,
        lastError: null,
        releasedReason: null,
        allocatedAt: at,
        releasedAt: null,
        expiresAt: row.expiresAt,
      })
      await store.updateMatch(row.id, { provider: provider.id, fleetServerId, updatedAt: at })
      Object.assign(row, { provider: provider.id, fleetServerId })
      // A row that opened is a concurrency count and a meter that started.
      // Tracked so a test's `settle()` waits for the warning, never awaited
      // here: the warning is emitted on this very match's chain, which this
      // walk is holding, and a warning must not be able to fail a walk.
      void track(
        options.budget
          .announce(row.keyId)
          .catch((error: unknown) => report(error, { phase: 'budget', matchId: row.id })),
      )

      let allocated: Awaited<ReturnType<typeof provider.allocate>>
      try {
        allocated = await provider.allocate({
          matchId: row.id,
          fleetServerId,
          keyId: row.keyId,
          requirements: { game: row.game },
          offering,
          ttlMinutes: request.ttlMinutes,
        })
      } catch (error) {
        // Rejection is expected, never exceptional — walk on.
        report(error, { phase: `allocate:${provider.id}`, matchId: row.id })
        await store.updateServer(fleetServerId, {
          state: 'failed',
          lastError: errorText(error),
          releasedAt: now(),
          releasedReason: 'allocate failed',
        })
        continue
      }

      attribution.set(serverKey({ provider: provider.id, serverId: allocated.serverId }), row.id)
      await store.updateServer(fleetServerId, {
        serverId: allocated.serverId,
        nodeId: allocated.nodeId ?? null,
        address: allocated.connect ?? null,
        tv: allocated.tv ?? null,
        providerMeta: allocated.meta ?? null,
      })
      await store.updateMatch(row.id, { serverId: allocated.serverId, updatedAt: now() })
      row.serverId = allocated.serverId
      await emit(row, {
        type: 'match.allocated',
        provider: provider.id,
        serverId: allocated.serverId,
        fleetServerId,
        region: offering.capabilities.region,
      })

      try {
        const joinPassword = mintJoinPassword(options.random)
        const serverToken = mintToken('server', options.random)
        await store.insertServerToken({
          id: randomUUID(),
          fleetServerId,
          tokenHash: hashToken(serverToken),
          createdAt: now(),
          lastUsedAt: null,
          revokedAt: null,
        })
        await provider.configure(allocated.serverId, {
          matchId: row.id,
          game: row.game,
          request,
          gamemode: manifest,
          joinPassword,
          link: { url: linkUrl(options.baseUrl), serverToken },
        })
        // Persisted now, shown from `ready` on: a restart between the two
        // must not lose the password the server was given.
        const connect = allocated.connect ? { ...allocated.connect, password: joinPassword } : null
        await store.updateMatch(row.id, { connect, tv: allocated.tv ?? null, updatedAt: now() })
        Object.assign(row, { connect, tv: allocated.tv ?? null })
        await provider.start(allocated.serverId)
      } catch (error) {
        report(error, { phase: `configure:${provider.id}`, matchId: row.id })
        await deallocateQuietly(candidate, allocated.serverId)
        links.detach({ provider: provider.id, serverId: allocated.serverId })
        attribution.delete(serverKey({ provider: provider.id, serverId: allocated.serverId }))
        await store.updateServer(fleetServerId, {
          state: 'failed',
          lastError: errorText(error),
          releasedAt: now(),
          releasedReason: 'configure failed',
        })
        continue
      }

      cancelTimer(row, 'allocate')
      await store.updateServer(fleetServerId, { state: 'configured' })
      await setState(row, 'configuring')
      armBoot(row)
      armHeartbeat(row)
      return
    }

    cancelTimer(row, 'allocate')
    const detail =
      selection.candidates.length === 0
        ? 'no_capable_server: no provider could host the request'
        : `no_capable_server: all ${selection.candidates.length} candidates failed`
    await fail(row, 'allocation_failed', detail)
  }

  // --- events from the server -----------------------------------------------------------

  const onServerEvent = async (
    row: MatchRow,
    source: ServerRef,
    event: GameserverEvent,
  ): Promise<IngestStatus> => {
    if (isTerminalMatchState(row.state)) return 'rejected'
    if (row.provider !== source.provider || row.serverId !== source.serverId) return 'rejected'
    if (event.matchId !== row.id) return 'rejected'
    const runtime = runtimeOf(row)
    if (event.seq !== undefined) {
      const mark = `${serverKey(source)}#${event.seq}`
      if (runtime.seen.has(mark)) return 'duplicate'
      runtime.seen.add(mark)
    }
    if (
      clock.now() - runtime.lastSeenWrittenAt >= LAST_SEEN_WRITE_INTERVAL_MS &&
      row.fleetServerId
    ) {
      runtime.lastSeenWrittenAt = clock.now()
      await store.updateServer(row.fleetServerId, { lastSeenAt: now() })
    }
    armHeartbeat(row)
    if (event.type === 'position_tick') {
      hub.tick(row.id, event)
      return 'ephemeral'
    }
    await emit(row, event)
    switch (event.type) {
      case 'server_ready': {
        if (row.state !== 'configuring') break
        cancelTimer(row, 'boot')
        const server = await currentServer(row)
        if (server?.address === null && row.provider && row.serverId) {
          // A provider that learns the address after allocation says so now.
          const status = await providers.get(row.provider)?.status(row.serverId)
          if (status?.connect && server) {
            await store.updateServer(server.id, {
              address: status.connect,
              tv: status.tv ?? null,
            })
            row.connect = {
              ...status.connect,
              ...(row.connect?.password && { password: row.connect.password }),
            }
            row.tv = status.tv ?? null
          }
        }
        if (server) await store.updateServer(server.id, { state: 'running' })
        await setState(row, 'ready', { readyAt: now(), connect: row.connect, tv: row.tv })
        if (row.connect)
          await emit(row, { type: 'match.server_ready', connect: row.connect, tv: row.tv })
        armJoin(row)
        break
      }
      case 'player_connected':
        runtime.presence.set(event.player.steamId64, event.player)
        await emit(row, {
          type: 'player.joined',
          player: event.player,
          rostered: runtime.known.has(event.player.steamId64),
        })
        presenceFrame(row)
        break
      case 'player_disconnected':
        runtime.presence.delete(event.player.steamId64)
        await emit(row, { type: 'player.left', player: event.player })
        presenceFrame(row)
        break
      case 'going_live':
        runtime.currentMap = event.mapNumber
        if (row.state === 'ready') {
          cancelTimer(row, 'join')
          await setState(row, 'live', { liveAt: now() })
        }
        break
      case 'series_end':
        await end(row, 'ended', { kind: 'completed' }, 'released')
        break
      default:
        break
    }
    return 'accepted'
  }

  /** The open match a server plays for, from attribution or the ledger. */
  const matchOf = async (source: ServerRef): Promise<MatchRow | undefined> => {
    let matchId = attribution.get(serverKey(source))
    if (!matchId) {
      const server = await store.findServerByHandle(source.provider, source.serverId)
      if (!server?.matchId || server.releasedAt) return undefined
      matchId = server.matchId
      attribution.set(serverKey(source), matchId)
    }
    return store.findMatch(matchId)
  }

  const ingest: ServerEventSink['ingest'] = async (source, event) => {
    if (closed) return 'rejected'
    const row = await matchOf(source)
    if (!row) return 'rejected'
    return enqueue(row, fresh => onServerEvent(fresh, source, event))
  }

  const touch: Matches['touch'] = async source => {
    if (closed) return
    const row = await matchOf(source)
    if (!row) return
    if (row.state === 'configuring' || row.state === 'ready' || row.state === 'live')
      armHeartbeat(row)
  }

  const assignment: Matches['assignment'] = async (source, hello) => {
    if (closed) return null
    const row = await matchOf(source)
    if (!row || isTerminalMatchState(row.state)) return null
    return enqueue(row, async fresh => {
      if (isTerminalMatchState(fresh.state)) return null
      if (fresh.provider !== source.provider || fresh.serverId !== source.serverId) return null
      const manifest = manifestOf(fresh)
      const missing = missingPlugins(manifest, hello.plugins)
      if (missing.length > 0) {
        await fail(
          fresh,
          'provider_error',
          `the server's image lacks ${missing.join(', ')}, which ${manifest.id} needs`,
        )
        return null
      }
      return composeAssign({
        matchId: fresh.id,
        request: fresh.requestJson,
        manifest,
        profiles: runtimeOf(fresh).known,
        installed: hello.plugins,
      })
    })
  }

  // --- the door ----------------------------------------------------------------------------

  const require = async (key: AuthenticatedKey, matchId: string): Promise<MatchRow> => {
    const row = await store.findMatch(matchId)
    if (!row || row.keyId !== key.key.id) throw refuse('not_found', `no match ${matchId}`)
    return row
  }

  const create = async (
    key: AuthenticatedKey,
    request: MatchRequest,
  ): Promise<CreateMatchResult> => {
    const existing = await store.findMatchByClientId(key.key.id, request.clientMatchId)
    const hash = requestHash(request)
    if (existing) {
      if (existing.requestHash === hash) return { match: view(existing), replayed: true }
      throw refuse(
        'conflict',
        `clientMatchId ${request.clientMatchId} was used with a different body`,
      )
    }
    if (!key.webhookSecrets.has(request.callbacks.webhookSecretId))
      throw refuse('validation_failed', 'callbacks.webhookSecretId is not registered on this key', {
        field: 'callbacks.webhookSecretId',
        registered: [...key.webhookSecrets.keys()],
      })
    try {
      simPlanFor(request)
    } catch (error) {
      if (error instanceof SimPlanError)
        throw refuse('validation_failed', error.message, { field: 'sim.scenario' })
      throw error
    }
    const manifest = gamemodes.find(m => m.id === request.gamemode)
    if (!manifest) throw refuse('unknown_gamemode', `no gamemode ${request.gamemode}`)
    // Capability first (decision 18: `csgo` is refused for want of a provider
    // before anything about the gamemode is said), then the manifest's rules.
    const selection = await selectCandidates(providers, request, { now: () => now().toISOString() })
    if (selection.candidates.length === 0) {
      if (selection.asked > 0 && selection.failures.length === selection.asked)
        throw refuse('provider_unavailable', 'no provider is answering', {
          providers: selection.failures.map(f => f.provider),
        })
      throw refuse('no_capable_server', describeNoCapacity(request, selection.asked))
    }
    if (manifest.game !== request.game)
      throw refuse('game_unsupported', `${manifest.id} plays ${manifest.game}, not ${request.game}`)
    for (const plan of request.maps) {
      if (!gamemodeAllowsMap(manifest.maps, plan.map))
        throw refuse('map_not_allowed', `${manifest.id} does not play ${plan.map}`, {
          map: plan.map,
        })
    }
    // Money last, and against the ledger (T5): concurrent servers, then the
    // request's own lifetime, then the month — priced at what the walk's
    // first candidate charges, which is what this match would actually cost.
    await options.budget.check(key.key, request, selection.candidates[0]?.offering.hourlyCents ?? 0)

    const at = now()
    const row: MatchRow = {
      id: randomUUID(),
      keyId: key.key.id,
      clientMatchId: request.clientMatchId,
      state: 'pending',
      stateChangedAt: at,
      game: request.game,
      gamemode: request.gamemode,
      provider: null,
      serverId: null,
      fleetServerId: null,
      connect: null,
      tv: null,
      seq: 0,
      requestJson: request,
      requestHash: hash,
      endedReason: null,
      sim: null,
      expiresAt: new Date(clock.now() + request.ttlMinutes * 60_000),
      readyAt: null,
      liveAt: null,
      endedAt: null,
      webhooksStoppedAt: null,
      createdAt: at,
      updatedAt: at,
    }
    await store.insertMatch(row)
    runtimeOf(row)
    armTtl(row)
    void enqueue(row, provision).catch((error: unknown) =>
      report(error, { phase: 'provision', matchId: row.id }),
    )
    return { match: view(row), replayed: false }
  }

  const cancel = async (key: AuthenticatedKey, matchId: string): Promise<Match> => {
    const row = await require(key, matchId)
    return enqueue(row, async fresh => {
      const { state } = fresh
      if (isTerminalMatchState(state) || state === 'live' || state === 'recovering')
        throw refuse('invalid_state', `cannot cancel a ${state} match; use force_end`)
      await end(fresh, 'cancelled', { kind: 'cancelled' }, 'released')
      return view(fresh)
    })
  }

  const applyCommand = async (row: MatchRow, body: MatchCommand): Promise<MatchCommandResult> => {
    const base = { correlationId: body.correlationId, type: body.type }
    const rejected = (code: MatchApiErrorCode, message: string): MatchCommandResult => ({
      ...base,
      status: 'rejected',
      code,
      message,
    })
    const { state } = row
    if (isTerminalMatchState(state)) return rejected('invalid_state', `the match is ${state}`)
    const runtime = runtimeOf(row)
    switch (body.type) {
      case 'force_end':
        if (state !== 'ready' && state !== 'live' && state !== 'recovering')
          return rejected('invalid_state', `cannot force_end a ${state} match; cancel it`)
        await end(
          row,
          'ended',
          { kind: 'force_ended', ...(body.reason && { detail: body.reason }) },
          'released',
        )
        return { ...base, status: 'applied' }
      case 'restore': {
        if (state !== 'recovering')
          return rejected('invalid_state', 'restore only while recovering')
        const backup = await store.latestBackup(row.id)
        if (!backup || (body.roundNumber !== undefined && backup.roundNumber !== body.roundNumber))
          return rejected('no_backup', 'no backup to restore from')
        return rejected(
          'command_unsupported',
          'restoring onto a new server arrives with PRD-02 T14',
        )
      }
      case 'profile': {
        const manifest = manifestOf(row)
        if (!manifest.slots.openJoin && !runtime.known.has(body.player.steamId64))
          return rejected('player_not_in_match', `${body.player.steamId64} is not on the roster`)
        runtime.known.set(body.player.steamId64, body.player)
        break
      }
      case 'kick':
        if (!runtime.presence.has(body.steamId64))
          return rejected('player_not_in_match', `${body.steamId64} is not on the server`)
        break
      case 'pause':
        if (state !== 'live') return rejected('invalid_state', 'pause only while live')
        break
      case 'unpause':
        if (state !== 'live') return rejected('invalid_state', 'unpause only while live')
        break
      default:
        break
    }
    // The `sim.*` family belongs to simulated servers and to nothing else
    // (decision 9): a real box has no time scale and no dice to load. Refused
    // here rather than at the channel, so the answer is the same whether the
    // match has a server yet or not.
    if (isSimCommand(body.type) && row.provider !== SIM_PROVIDER_ID)
      return rejected(
        'command_unsupported',
        `${body.type} needs a simulated server; this match runs on ${row.provider ?? 'no provider yet'}`,
      )
    const channel =
      row.provider && row.serverId
        ? links.get({ provider: row.provider, serverId: row.serverId })
        : undefined
    if (!channel) {
      // A profile push for a server that is not up yet is kept for it.
      if (body.type === 'profile') return { ...base, status: 'applied' }
      return rejected('invalid_state', `no server while ${state}`)
    }
    let answer: Awaited<ReturnType<typeof channel.send>>
    try {
      answer = await channel.send(body)
    } catch (error) {
      report(error, { phase: `command:${body.type}`, matchId: row.id })
      return rejected('provider_unavailable', 'the server did not answer')
    }
    if (answer.status !== 'rejected') {
      if (body.type === 'pause') {
        runtime.paused = true
        cancelTimer(row, 'heartbeat')
      } else if (body.type === 'unpause') {
        runtime.paused = false
        armHeartbeat(row)
      }
    }
    return { ...base, ...answer }
  }

  const command = async (
    key: AuthenticatedKey,
    matchId: string,
    body: MatchCommand,
  ): Promise<MatchCommandResult> => {
    const row = await require(key, matchId)
    if (body.type === 'rcon' && !key.key.scopes.includes('admin'))
      throw refuse('forbidden', 'rcon needs the admin scope', { scope: 'admin' })
    return enqueue(row, async fresh => {
      const cached = await store.findCommand(fresh.id, body.correlationId)
      if (cached?.resultJson) return cached.resultJson
      if (!cached) {
        const at = now()
        await store.insertCommand({
          matchId: fresh.id,
          correlationId: body.correlationId,
          commandJson: body,
          resultJson: null,
          createdAt: at,
          updatedAt: at,
        })
      }
      const result = await applyCommand(fresh, body)
      await store.setCommandResult(fresh.id, body.correlationId, result, now())
      hub.publish(fresh.id, { type: 'command_result', result })
      return result
    })
  }

  const events: Matches['events'] = async (key, matchId, afterSeq, limit) => {
    const row = await require(key, matchId)
    const rows = await store.listEvents(matchId, afterSeq, limit)
    const items = rows.map(event => envelopeOf(row, event))
    const last = items.at(-1)
    const caughtUp = (last?.seq ?? afterSeq) >= row.seq
    const nextCursor =
      caughtUp && isTerminalMatchState(row.state) ? null : String(last ? last.seq : afterSeq)
    return { items, nextCursor }
  }

  // --- the reaper's and the fleet's doors ---------------------------------------------------

  const emitTo = async (
    matchId: string,
    payload: WebhookPayload,
  ): Promise<WebhookEnvelope | null> => {
    const row = await store.findMatch(matchId)
    if (!row || isTerminalMatchState(row.state)) return null
    return enqueue(row, fresh => emit(fresh, payload))
  }

  const suspect = async (matchId: string, detail: string): Promise<void> => {
    const row = await store.findMatch(matchId)
    if (!row) return
    await enqueue(row, fresh => probeOrLose(fresh, detail))
  }

  const probeOrLose = async (row: MatchRow, detail: string): Promise<void> => {
    if (row.state !== 'configuring' && row.state !== 'ready' && row.state !== 'live') return
    const provider = row.provider ? providers.get(row.provider) : undefined
    if (!provider || !row.serverId) return
    try {
      const { state } = await provider.status(row.serverId)
      if (state !== 'gone' && state !== 'stopped') return
    } catch {
      return
    }
    await lost(row, detail)
  }

  const expire = async (matchId: string, detail: string): Promise<void> => {
    const row = await store.findMatch(matchId)
    if (!row) return
    await enqueue(row, fresh => end(fresh, 'ended', { kind: 'ttl_expired', detail }, 'released'))
  }

  const releaseRow: Matches['releaseRow'] = async (server, reason) => {
    const detail = `released by operator${reason ? `: ${reason}` : ''}`
    const row = server.matchId ? await store.findMatch(server.matchId) : undefined
    if (row && !isTerminalMatchState(row.state) && row.fleetServerId === server.id) {
      // The match fails (its server was taken away); the row was *released*,
      // deliberately, by a person — which is what the ledger should say.
      await enqueue(row, fresh =>
        end(fresh, 'failed', { kind: 'provider_error', detail }, 'released'),
      )
      return
    }
    await closeRow(server, 'released', detail, true)
  }

  // --- lifecycle ------------------------------------------------------------------------------

  const resume = async (): Promise<void> => {
    for (const row of await store.listOpenMatches()) {
      runtimeOf(row)
      if (row.provider && row.serverId)
        attribution.set(serverKey({ provider: row.provider, serverId: row.serverId }), row.id)
      armTtl(row)
      switch (row.state) {
        case 'pending':
        case 'allocating':
          // A walk that died with the process: whatever it left is the reaper's.
          void enqueue(row, provision).catch((error: unknown) =>
            report(error, { phase: 'resume:provision', matchId: row.id }),
          )
          break
        case 'configuring':
          armBoot(row)
          armHeartbeat(row)
          break
        case 'ready':
          armJoin(row)
          armHeartbeat(row)
          break
        case 'live':
          armHeartbeat(row)
          break
        case 'recovering':
          armRecovery(row)
          break
        default:
          break
      }
    }
  }

  const settle = async (): Promise<void> => {
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }

  return {
    ingest,
    create,
    get: async (key, matchId) => view(await require(key, matchId)),
    list: async (key, filter, cursor, limit) => {
      const result = await store.listMatches(key.key.id, filter, offsetOf(cursor), limit)
      return page(result.items.map(view), result.nextOffset)
    },
    cancel,
    command,
    events,
    require,
    view,
    emit: emitTo,
    suspect,
    touch,
    assignment,
    expire,
    releaseRow,
    resume,
    settle,
    async close() {
      closed = true
      for (const [id, runtime] of runtimes) {
        for (const timer of Object.values(runtime.timers)) timer?.cancel()
        runtime.timers = {}
        runtimes.delete(id)
      }
      await settle()
    },
  }
}

function describeNoCapacity(request: MatchRequest, asked: number): string {
  const { requirements } = request
  if (request.game !== 'cs2') return `no provider advertises ${request.game}`
  if (requirements.lan) return 'no LAN node has free capacity'
  if (requirements.provider) return `no capacity on provider ${requirements.provider}`
  if (requirements.region) return `no capacity in ${requirements.region}`
  if (asked === 0) return 'no provider is registered or every provider is drained'
  return 'no provider has a free server'
}

/** A join password: short, random, never one of our tokens. */
function mintJoinPassword(random?: RandomBytes): string {
  const bytes = random ? random(9) : null
  return (bytes ?? Buffer.from(randomUUID().replace(/-/g, '').slice(0, 18), 'hex'))
    .toString('base64url')
    .slice(0, 12)
}

/** Where a server's plugin dials the link: the orchestrator's origin as `ws(s)`, plus the path. */
export function linkUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = SERVER_LINK_PATH
  return url.href
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
