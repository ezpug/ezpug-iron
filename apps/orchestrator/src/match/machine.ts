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
  PlayerToken,
  PlayerTokenRequest,
  RosterEntry,
  WebhookEnvelope,
  WebhookPayload,
  WidgetCommandResultFrame,
} from '@ezpug/match-api'
import {
  ApiError,
  gamemodeAllowsMap,
  isSimCommand,
  isTerminalMatchState,
  MATCH_API_ERROR_STATUS,
  matchDemoOutcome,
  STREAM_CLOSE_CODES,
} from '@ezpug/match-api'
import {
  BACKUP_RESTORED_EVENT,
  HEARTBEAT_INTERVAL_MS_DEFAULT,
  type OrchestratorFrameOf,
  type RoundBackup,
  SERVER_LINK_PATH,
} from '@ezpug/protocol'
import { SIM_PROVIDER_ID } from '@ezpug/sim'
import type { BudgetGate } from '../budget/service'
import type { AuthenticatedKey, Keys } from '../keys/service'
import { composeAssign, missingPlugins } from '../link/assign'
import type {
  IngestStatus,
  LinkRegistry,
  PlayerCommandRelay,
  ServerEventSink,
  ServerRef,
} from '../link/channels'
import { serverKey } from '../link/channels'
import type { Log } from '../log'
import type { ProviderRegistry } from '../providers/registry'
import type { AllocationCandidate } from '../providers/selection'
import { selectCandidates } from '../providers/selection'
import { SimPlanError, simPlanFor } from '../providers/sim/provider'
import type { StreamHub } from '../stream/hub'
import { hashToken, mintToken, type RandomBytes } from '../tokens'
import type { BackupRow, MatchRow, MatchStore, ServerRow } from './store'
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
 * worker.
 *
 * **Recovery** (T14) is the walk again, from `recovering`: a live match whose
 * server is gone says `match.recovering` with the newest backup's round,
 * closes the dead row, and — when there is a backup — walks the candidates
 * a second time (`recover`), with the backup: the provider gets it through
 * `restore` when that is its way (the sim), and the plugin gets it in
 * `assign.restore` over the link (a node, Dathost). The replacement's
 * `server_ready` re-announces the connect facts (`match.server_ready` with
 * `restored: true` and the round) and re-arms the join deadline; the first
 * sign it is playing (`resumed`) says `match.recovered` and the match is
 * `live` again. No backup, an exhausted list, the window or the join
 * deadline running out, or the replacement dying too: `failed: server_lost`,
 * with everything recorded kept.
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
  /**
   * **The demo window** (T21): how long after the gamemode said its series was
   * over the match waits for the demo before ending anyway. GOTV records the
   * *delayed* broadcast, so a `.dem` is only complete `tv_delay` seconds after
   * the last round — and the server that holds it is released the moment the
   * match ends. Only armed for a match that records a demo and was given
   * somewhere to put it, and only until the demo is announced.
   *
   * Six minutes covers the plugin's whole timeline with room to spare: a GOTV
   * delay of 105 s, the settle window it needs to know the file is finished,
   * and the PUT itself with its retries (`DemoFlow` in `plugins/EZPug.Core`,
   * whose own patience is four minutes).
   */
  demoMs: number
  /** No event from a live server for this long and it is probed. */
  heartbeatTimeoutMs: number
}

export const DEFAULT_MATCH_DEADLINES: MatchDeadlines = {
  allocateMs: 2 * 60_000,
  bootMs: 5 * 60_000,
  joinMs: 20 * 60_000,
  recoveryMs: 5 * 60_000,
  demoMs: 6 * 60_000,
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
  /** The keys, for the one thing a fact's delivery asks of them: the key's fleet webhook (T31). */
  keys: Pick<Keys, 'get'>
  /** The orchestrator's own origin — what a server's plugin dials the link at. */
  baseUrl: string
  deadlines?: Partial<MatchDeadlines>
  /** Injectable for a test that pins a password's shape; defaults to the CSPRNG. */
  random?: RandomBytes
  onError?: (error: unknown, context: Record<string, unknown>) => void
}

/** What became of a widget's tap, as the socket answers it (minus the frame's envelope). */
export type WidgetTapOutcome = Omit<WidgetCommandResultFrame, 'type' | 'correlationId' | 'command'>

/** What the widget socket's `hello` is built from (T24). */
export interface WidgetFacts {
  row: MatchRow
  manifest: GamemodeManifest
  /** The player's roster profile — pushed or requested — when the match knows them. */
  profile: RosterEntry | undefined
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
  /**
   * `POST /v1/matches/:matchId/player-tokens` (T24, decision 17): a widget's
   * key to this match and one SteamID64 — a rostered player, one the server
   * has seen join, or anyone on an open-join mode — hashed here, shown once.
   * Refused `invalid_state` once the match is over.
   */
  mintPlayerToken: (
    key: AuthenticatedKey,
    matchId: string,
    body: PlayerTokenRequest,
  ) => Promise<PlayerToken>
  /** What a widget socket's `hello` says about its token's match and player; undefined for no such match. */
  widgetFacts: (matchId: string, steamId64: string) => Promise<WidgetFacts | undefined>
  /**
   * A widget's tap (T24): relayed to the match's server as a `player_command`
   * frame and answered with what the SDK said. Refused here, without a
   * message — the socket says it in the player's language — when the match
   * is not `live` or has no reachable server (`not_live`), when the manifest
   * declares no such verb (`unknown_command`), or when the server did not
   * answer inside the relay deadline (`unavailable`). Never holds the
   * match's chain: a real plugin reports the tap's `plugin_event` before it
   * answers the tap.
   */
  playerCommand: (matchId: string, tap: PlayerCommandRelay) => Promise<WidgetTapOutcome>
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

type TimerName = 'allocate' | 'boot' | 'join' | 'recovery' | 'heartbeat' | 'ttl' | 'demo'

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
  /** While `recovering`: the backup the replacement is (to be) handed. */
  restoring: { mapNumber: number; roundNumber: number } | null
  /** While `recovering`: a replacement walk is queued or running. */
  recovering: boolean
  /** While `recovering`: the replacement's `server_ready` has been announced. */
  replacementReady: boolean
  /**
   * While `recovering`: the sign of play that reached us before the
   * replacement's connect facts did — a plugin loads the backup on its way up,
   * so `backup_restored` arrives before `server_ready`. Held so a client never
   * hears `match.recovered` for a server it has not been told about.
   */
  resumePending: string | null
  /**
   * The demos this match's servers announced, and how many of those they had
   * already put where the request said (T21) — what `match.ended.demo`
   * reports. In memory beside the presence map: an orchestrator restarted
   * mid-match forgets both, and the durable log keeps the facts either way.
   */
  demos: { announced: number; uploaded: number }
  /** `series_end` arrived and the match is holding the server open for its demo. */
  awaitingDemo: boolean
}

/** Round backups kept per match — MatchZy writes one a round; recovery wants the newest. */
export const BACKUPS_KEPT_PER_MATCH = 8

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
        restoring: null,
        recovering: false,
        replacementReady: false,
        resumePending: null,
        demos: { announced: 0, uploaded: 0 },
        awaitingDemo: false,
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
   * **Where one envelope is POSTed** (T31). A `fleet.*` fact is about the
   * key's capacity, not about the match it is numbered in, so a key that
   * registered a fleet webhook hears its four of them there — one endpoint
   * for the console tile that watches the fleet, instead of a subscription
   * to every match's callback — signed with the secret that registration
   * named. Everything else, and every fact of a key without one, goes to the
   * match's own `callbacks.webhookUrl` exactly as before.
   *
   * A key that vanished (revoked and swept) or lost the secret between the
   * registration and the fact falls back to the match's callback rather than
   * to nothing: the events route holds the fact either way, and a delivery
   * to a known endpoint beats a delivery to none.
   */
  const destinationFor = async (
    row: MatchRow,
    payload: WebhookPayload,
  ): Promise<{ url: string; secretId: string }> => {
    const match = {
      url: row.requestJson.callbacks.webhookUrl,
      secretId: row.requestJson.callbacks.webhookSecretId,
    }
    if (!payload.type.startsWith('fleet.')) return match
    try {
      const key = await options.keys.get(row.keyId)
      const fleet = key?.key.fleetWebhook
      return fleet && key?.webhookSecrets.has(fleet.secretId) ? fleet : match
    } catch (error) {
      report(error, { phase: 'fleet-webhook', matchId: row.id })
      return match
    }
  }

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
      const destination = await destinationFor(row, payload)
      await store.insertDelivery({
        deliveryId: event.deliveryId,
        matchId: row.id,
        seq: event.seq,
        url: destination.url,
        secretId: destination.secretId,
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

  // --- demos (T21) --------------------------------------------------------------------

  /**
   * The object key the demo landed under, read out of the presigned URL the
   * request carried — the same rule the published fake uses. The orchestrator
   * never sees a byte of a demo; this is the one thing it can say about where
   * one went.
   */
  const demoKeyOf = (row: MatchRow): string | undefined => {
    const url = row.requestJson.callbacks.demoUploadUrl
    if (!url) return undefined
    try {
      const key = new URL(url).pathname.replace(/^\/+/, '')
      return key.length > 0 ? key : undefined
    } catch {
      return undefined
    }
  }

  /** What became of this match's demos, by the contract's own rule. */
  const demoOf = (row: MatchRow) => {
    const runtime = runtimes.get(row.id)
    return matchDemoOutcome({
      recordsDemo: manifestOf(row).records === 'demo',
      hasUploadUrl: row.requestJson.callbacks.demoUploadUrl !== undefined,
      announced: runtime?.demos.announced ?? 0,
      uploaded: runtime?.demos.uploaded ?? 0,
    })
  }

  /**
   * Whether the match should hold its server open past `series_end` for a demo
   * that has not been announced yet: the mode records one, the request said
   * where to put it, and fewer demos have arrived than maps were played.
   */
  const demoPending = (row: MatchRow, runtime: Runtime): boolean =>
    manifestOf(row).records === 'demo' &&
    row.requestJson.callbacks.demoUploadUrl !== undefined &&
    runtime.demos.announced < runtime.currentMap

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
    else await emit(row, { type: 'match.ended', state, reason, demo: demoOf(row) }, patch)
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

  /**
   * The demo window: end the match anyway when the demo does not come. The
   * fact is honest either way — `match.ended.demo` then says `no_demo`.
   */
  const armDemo = (row: MatchRow): void =>
    setTimer(row, 'demo', clock.now() + deadlines.demoMs, fresh => {
      const runtime = runtimes.get(fresh.id)
      if (!runtime?.awaitingDemo) return Promise.resolve()
      runtime.awaitingDemo = false
      log.info(
        `match ${fresh.id}: no demo within ${deadlines.demoMs} ms of series_end; ending without it`,
      )
      return end(fresh, 'ended', { kind: 'completed' }, 'released')
    })

  const armJoin = (row: MatchRow): void =>
    setTimer(row, 'join', row.stateChangedAt.getTime() + deadlines.joinMs, fresh => {
      if (fresh.state === 'ready')
        return end(
          fresh,
          'ended',
          { kind: 'ttl_expired', detail: `no going_live within ${deadlines.joinMs} ms of ready` },
          'released',
        )
      // The replacement stood ready and never played a beat: the match was
      // live and could not be restored, which is what `server_lost` means.
      if (fresh.state === 'recovering')
        return fail(
          fresh,
          'server_lost',
          `no sign of play within ${deadlines.joinMs} ms of the replacement being ready`,
        )
      return Promise.resolve()
    })

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
    if (!probeable(row.state)) return
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

  /**
   * The server is gone. Before `live` the match fails; from `live` the
   * window opens and the replacement walk is queued behind this step. A
   * replacement that dies while the window is open ends the match — one
   * recovery per loss, never a chase.
   */
  const lost = async (row: MatchRow, reason: string): Promise<void> => {
    if (isTerminalMatchState(row.state)) return
    if (row.state === 'recovering') {
      const replacement = await currentServer(row)
      if (!replacement || replacement.releasedAt) return
      await fail(row, 'server_lost', `the replacement server was lost while restoring: ${reason}`)
      return
    }
    if (row.state !== 'live') {
      await fail(row, 'provider_error', `server lost before going live: ${reason}`)
      return
    }
    cancelTimer(row, 'heartbeat')
    const runtime = runtimeOf(row)
    runtime.replacementReady = false
    runtime.resumePending = null
    const backup = await store.latestBackup(row.id)
    await emit(row, {
      type: 'match.recovering',
      reason: reason.slice(0, 256),
      backupRound: backup?.roundNumber ?? null,
    })
    await setState(row, 'recovering')
    const server = await currentServer(row)
    if (server) await closeRow(server, 'failed', `server lost: ${reason}`, true)
    // Whoever was on the dead box is not on the next one until it says so.
    runtime.presence.clear()
    presenceFrame(row)
    if (!backup) {
      await fail(row, 'server_lost', 'no backup to restore from')
      return
    }
    armRecovery(row)
    runtime.restoring = { mapNumber: backup.mapNumber, roundNumber: backup.roundNumber }
    kickRecovery(row)
  }

  /** Queue the replacement walk behind the step that is running, once. */
  const kickRecovery = (row: MatchRow): void => {
    const runtime = runtimeOf(row)
    if (runtime.recovering) return
    runtime.recovering = true
    void enqueue(row, recover)
      .catch((error: unknown) => report(error, { phase: 'recover', matchId: row.id }))
      .finally(() => {
        runtime.recovering = false
      })
  }

  /** The backup a recovering match resumes from: the point chosen at the loss (or by `restore`), else the newest. */
  const restorePoint = async (row: MatchRow): Promise<BackupRow | undefined> => {
    const point = runtimeOf(row).restoring
    if (point) {
      const chosen = (await store.listBackups(row.id)).find(
        backup => backup.mapNumber === point.mapNumber && backup.roundNumber === point.roundNumber,
      )
      if (chosen) return chosen
    }
    return store.latestBackup(row.id)
  }

  // --- the provisioning walk ----------------------------------------------------------------

  /**
   * The walk itself, shared by a fresh match (`provision`) and a recovering
   * one (`recover`): a ledger row before each candidate is asked, the next
   * candidate on any failure, and `true` once a server is configured and
   * started. `restore` is the backup a replacement is handed — through the
   * provider's own verb where it has one, and always in the assignment the
   * link composes for it (`assignment`).
   */
  const walk = async (
    row: MatchRow,
    until: number,
    restore: BackupRow | undefined,
  ): Promise<{ found: boolean; candidates: number }> => {
    const request = row.requestJson
    const manifest = manifestOf(row)
    const selection = await selectCandidates(providers, request, { now: () => now().toISOString() })
    for (const failure of selection.failures)
      report(failure.error, { phase: `offerings:${failure.provider}`, matchId: row.id })

    for (const candidate of selection.candidates) {
      if (clock.now() >= until) break
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
        // Written by the GSLT pool when the provider leases one (T17).
        gsltTokenId: null,
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
        if (restore && provider.restore) {
          // A provider whose servers take the backup through the control
          // plane (the sim; Dathost's file upload one day). `false` means
          // not its way, and the assignment over the link carries it instead.
          const taken = await provider.restore(allocated.serverId, {
            mapNumber: restore.mapNumber,
            roundNumber: restore.roundNumber,
            filename: restore.filename,
            content: restore.content,
          })
          log.info(
            `match ${row.id}: backup round ${restore.roundNumber} ${taken ? 'loaded through' : 'left to the link on'} ${provider.id}/${allocated.serverId}`,
          )
        }
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

      await store.updateServer(fleetServerId, { state: 'configured' })
      return { found: true, candidates: selection.candidates.length }
    }
    return { found: false, candidates: selection.candidates.length }
  }

  const noCapableServer = (candidates: number): string =>
    candidates === 0
      ? 'no_capable_server: no provider could host the request'
      : `no_capable_server: all ${candidates} candidates failed`

  const provision = async (row: MatchRow): Promise<void> => {
    if (row.state !== 'pending' && row.state !== 'allocating') return
    if (row.state === 'pending') await setState(row, 'allocating')
    armAllocate(row)
    const { found, candidates } = await walk(
      row,
      row.stateChangedAt.getTime() + deadlines.allocateMs,
      undefined,
    )
    cancelTimer(row, 'allocate')
    if (!found) {
      await fail(row, 'allocation_failed', noCapableServer(candidates))
      return
    }
    await setState(row, 'configuring')
    armBoot(row)
    armHeartbeat(row)
  }

  /**
   * The walk for a recovering match: the same candidates, the same rules,
   * with the backup. The match stays `recovering` throughout — the window
   * armed at the loss is the deadline for the replacement's `server_ready`,
   * and `server_ready` is where the join deadline takes over.
   */
  const recover = async (row: MatchRow): Promise<void> => {
    if (row.state !== 'recovering') return
    const open = await currentServer(row)
    if (open && !open.releasedAt) return
    const backup = await restorePoint(row)
    if (!backup) {
      await fail(row, 'server_lost', 'no backup to restore from')
      return
    }
    const { found, candidates } = await walk(
      row,
      row.stateChangedAt.getTime() + deadlines.recoveryMs,
      backup,
    )
    if (row.state !== 'recovering') return
    if (!found) {
      await fail(row, 'server_lost', `no server to restore onto: ${noCapableServer(candidates)}`)
      return
    }
    armHeartbeat(row)
  }

  /**
   * **The window closes on the first sign the replacement is playing** (T37a).
   * It used to close on `going_live` alone, which is true of a flow that
   * restarts its series and false of the one that matters: MatchZy says
   * `going_live` once per series and, after `matchzy_loadbackup`, resumes from
   * the checkpoint without repeating it — so on hardware a match whose server
   * was up and playing sat in `recovering` until the join deadline failed it
   * `server_lost` (T37, the LAN rehearsal). Three signs close it now: that
   * `going_live` where a flow does say it, the plugin's `backup_restored`, and
   * the first `round_end` on the replacement if both were somehow missed. The
   * deadlines are untouched, so a replacement that truly never came still
   * fails.
   *
   * A plugin loads the backup on its way up, before it reports the map is
   * ready, so a sign that arrives ahead of the replacement's `server_ready` is
   * held until the client has its connect facts: `match.recovered` never comes
   * before the `match.server_ready` it belongs to.
   */
  const resumed = async (row: MatchRow, source: ServerRef, sign: string): Promise<void> => {
    if (row.state !== 'recovering' || !row.fleetServerId) return
    const runtime = runtimeOf(row)
    if (!runtime.replacementReady) {
      runtime.resumePending = sign
      return
    }
    cancelTimer(row, 'join')
    cancelTimer(row, 'recovery')
    runtime.resumePending = null
    log.info(`match ${row.id}: recovered on ${sign}`)
    await emit(row, {
      type: 'match.recovered',
      serverId: source.serverId,
      fleetServerId: row.fleetServerId,
      resumedFromRound: runtime.restoring?.roundNumber ?? null,
    })
    runtime.restoring = null
    await setState(row, 'live')
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
        if (row.state !== 'configuring' && row.state !== 'recovering') break
        const restoring = row.state === 'recovering'
        cancelTimer(row, restoring ? 'recovery' : 'boot')
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
        // A replacement stays `recovering` until it goes live; the state is
        // re-stamped so the join deadline (and a restart) count from here.
        await setState(row, restoring ? 'recovering' : 'ready', {
          readyAt: now(),
          connect: row.connect,
          tv: row.tv,
        })
        if (row.connect) {
          const round = runtime.restoring?.roundNumber
          await emit(row, {
            type: 'match.server_ready',
            connect: row.connect,
            tv: row.tv,
            ...(restoring && round !== undefined && { restored: true, round }),
          })
        }
        armJoin(row)
        if (restoring) {
          runtime.replacementReady = true
          // The backup was loaded on the way up: the sign was waiting for this.
          if (runtime.resumePending) await resumed(row, source, runtime.resumePending)
        }
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
        } else if (row.state === 'recovering') {
          await resumed(row, source, 'going_live')
        }
        break
      case 'plugin_event':
        // The one `plugin_event` the machine reads: a restored server saying
        // it has the backup, which on a `matchzy` flow is the only sign of the
        // resume that ever comes (T37a).
        if (event.name === BACKUP_RESTORED_EVENT && row.state === 'recovering')
          await resumed(row, source, `the plugin's ${BACKUP_RESTORED_EVENT}`)
        break
      case 'round_end':
        // A round ended on the replacement: whatever else was missed, it is
        // playing. Last of the three signs, and the one no flow can withhold.
        if (row.state === 'recovering')
          await resumed(row, source, `round ${event.roundNumber} ending on the replacement`)
        break
      case 'demo_available': {
        runtime.demos.announced += 1
        // A hash means the server already PUT the file where the request said
        // (decision 10): it owns the upload, the orchestrator owns the fact.
        if (event.sha256 && event.contentType) {
          runtime.demos.uploaded += 1
          const key = demoKeyOf(row)
          await emit(row, {
            type: 'demo.uploaded',
            mapNumber: event.mapNumber,
            ...(key !== undefined && { key }),
            size: event.sizeBytes ?? 0,
            sha256: event.sha256,
            contentType: event.contentType,
          })
        }
        if (runtime.awaitingDemo && !demoPending(row, runtime)) {
          cancelTimer(row, 'demo')
          runtime.awaitingDemo = false
          await end(row, 'ended', { kind: 'completed' }, 'released')
        }
        break
      }
      case 'series_end':
        // The series is over, but a GOTV demo is only finished `tv_delay`
        // after the last round and the server is released the moment the
        // match ends — so a match that records one waits for it (T21).
        if (demoPending(row, runtime)) {
          runtime.awaitingDemo = true
          armDemo(row)
          break
        }
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
    if (probeable(row.state)) armHeartbeat(row)
  }

  const backup: ServerEventSink['backup'] = async (source, backup) => {
    if (closed) return false
    const row = await matchOf(source)
    if (!row || isTerminalMatchState(row.state)) return false
    await store.upsertBackup(
      {
        id: randomUUID(),
        matchId: row.id,
        fleetServerId: row.fleetServerId,
        mapNumber: backup.mapNumber,
        roundNumber: backup.roundNumber,
        filename: backup.filename,
        content: backup.content,
        createdAt: now(),
      },
      BACKUPS_KEPT_PER_MATCH,
    )
    return true
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
      const restore = fresh.state === 'recovering' ? await restorePoint(fresh) : undefined
      return composeAssign({
        matchId: fresh.id,
        request: fresh.requestJson,
        manifest,
        profiles: runtimeOf(fresh).known,
        installed: hello.plugins,
        ...(restore && { restore: roundBackupOf(restore) }),
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
      deployment: store.deployment,
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
        // The orchestrator restores by itself the moment a live server is
        // lost; this is the door for the gap it cannot cover — a process
        // that restarted with the window open and no walk running.
        if (state !== 'recovering')
          return rejected('invalid_state', 'restore only while recovering')
        const backups = await store.listBackups(row.id)
        const chosen =
          body.roundNumber === undefined
            ? backups[0]
            : backups.find(candidate => candidate.roundNumber === body.roundNumber)
        if (!chosen) return rejected('no_backup', 'no backup to restore from')
        const open = await currentServer(row)
        if (runtime.recovering || (open && !open.releasedAt))
          return rejected('invalid_state', 'a restore is already in progress')
        runtime.restoring = { mapNumber: chosen.mapNumber, roundNumber: chosen.roundNumber }
        kickRecovery(row)
        return { ...base, status: 'applied' }
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

  const mintPlayerToken: Matches['mintPlayerToken'] = async (key, matchId, body) => {
    const row = await require(key, matchId)
    if (isTerminalMatchState(row.state))
      throw refuse('invalid_state', `the match is ${row.state}`, { state: row.state })
    const manifest = manifestOf(row)
    const runtime = runtimeOf(row)
    if (
      !manifest.slots.openJoin &&
      !runtime.known.has(body.steamId64) &&
      !runtime.presence.has(body.steamId64)
    )
      throw refuse(
        'player_not_in_match',
        `${body.steamId64} is neither on the roster nor on the server`,
        { steamId64: body.steamId64 },
      )
    const token = mintToken('player', options.random)
    const at = now()
    const expiresAt = new Date(at.getTime() + body.ttlSeconds * 1000)
    await store.insertPlayerToken({
      id: randomUUID(),
      matchId: row.id,
      keyId: key.key.id,
      steamId64: body.steamId64,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: at,
      revokedAt: null,
    })
    return { token, matchId: row.id, steamId64: body.steamId64, expiresAt: expiresAt.toISOString() }
  }

  /** The player's profile as the match knows it: pushed since, or the request's roster. */
  const profileOf = (row: MatchRow, steamId64: string): RosterEntry | undefined => {
    const pushed = runtimes.get(row.id)?.known.get(steamId64)
    if (pushed) return pushed
    const { teamA, teamB } = row.requestJson.teams
    return [...teamA.players, ...teamB.players].find(player => player.steamId64 === steamId64)
  }

  const widgetFacts: Matches['widgetFacts'] = async (matchId, steamId64) => {
    const row = await store.findMatch(matchId)
    if (!row) return undefined
    return { row, manifest: manifestOf(row), profile: profileOf(row, steamId64) }
  }

  const playerCommand: Matches['playerCommand'] = async (matchId, tap) => {
    const rejected = (code: WidgetTapOutcome['code']): WidgetTapOutcome => ({
      status: 'rejected',
      code,
    })
    const row = await store.findMatch(matchId)
    if (row?.state !== 'live') return rejected('not_live')
    if (!manifestOf(row).commands.some(command => command.name === tap.command))
      return rejected('unknown_command')
    const channel =
      row.provider && row.serverId
        ? links.get({ provider: row.provider, serverId: row.serverId })
        : undefined
    if (!channel?.playerCommand) return rejected('not_live')
    try {
      const answer = await channel.playerCommand(tap)
      return {
        status: answer.status,
        ...(answer.code !== undefined && { code: answer.code }),
        ...(answer.message !== undefined && { message: answer.message }),
        ...(answer.cooldownMs !== undefined && { cooldownMs: answer.cooldownMs }),
        ...(answer.chargesLeft !== undefined && { chargesLeft: answer.chargesLeft }),
      }
    } catch (error) {
      report(error, { phase: `player_command:${tap.command}`, matchId: row.id })
      return rejected('unavailable')
    }
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
    if (!probeable(row.state)) return
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
        case 'recovering': {
          // A replacement already running waits for its players (join);
          // one still booting has the window; none at all means the walk
          // died with the process — run it again.
          const replacement = await currentServer(row)
          const newest = await store.latestBackup(row.id)
          if (newest)
            runtimeOf(row).restoring = {
              mapNumber: newest.mapNumber,
              roundNumber: newest.roundNumber,
            }
          if (replacement && !replacement.releasedAt && replacement.state === 'running') {
            // It said `server_ready` before the restart, so the next sign of
            // play closes the window rather than waiting for another one.
            runtimeOf(row).replacementReady = true
            armJoin(row)
            armHeartbeat(row)
          } else if (replacement && !replacement.releasedAt) {
            armRecovery(row)
            armHeartbeat(row)
          } else {
            armRecovery(row)
            kickRecovery(row)
          }
          break
        }
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
    backup,
    create,
    get: async (key, matchId) => view(await require(key, matchId)),
    list: async (key, filter, cursor, limit) => {
      const result = await store.listMatches(key.key.id, filter, offsetOf(cursor), limit)
      return page(result.items.map(view), result.nextOffset)
    },
    cancel,
    command,
    mintPlayerToken,
    widgetFacts,
    playerCommand,
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

/** The states in which a server is expected to be heard from, and is probed when it is not. */
function probeable(state: MatchState): boolean {
  return state === 'configuring' || state === 'ready' || state === 'live' || state === 'recovering'
}

/** A stored backup as the link carries it down in `assign.restore`. */
function roundBackupOf(backup: BackupRow): RoundBackup {
  return {
    mapNumber: backup.mapNumber,
    roundNumber: backup.roundNumber,
    filename: backup.filename,
    content: backup.content,
  }
}
