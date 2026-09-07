/**
 * **The fake orchestrator's core** — the state and the machine behind every
 * route: keys and their secrets, the ledger, the matches and the simulated
 * servers that play them, the envelope log with its webhooks and stream, the
 * fault knobs. The route handlers (`handlers.ts`), the HTTP adapter
 * (`http.ts`) and the in-process client are thin layers over this.
 *
 * One rule keeps it reproducible: **everything that touches a match runs on
 * that match's chain**, one step at a time, in the order it was asked — a
 * server's event, a command, a cancel, a deadline. A step may await (the demo
 * `PUT`), and the next event of the same match waits behind it, so
 * `demo.uploaded` follows `demo_available` and precedes `series_end` however
 * the clock is advanced. Ids, passwords and tokens come from the seeded PRNG
 * in that same order. Same clock, same seed, same options: same envelopes.
 */
import type { Timer } from '@ezpug/core'
import { createPrng } from '@ezpug/core'
import type { MatchAssignment, SimBackup, SimPlan, SimulatedServer } from '@ezpug/sim'
import {
  assignmentFromMatchRequest,
  createSimulatedServer,
  findScenario,
  SIM_PLAYER_COMMAND_EVENT,
  SIM_PROVIDER_ID,
  SIMULATED_MATCH_RECORD_CONTENT_TYPE,
} from '@ezpug/sim'
import { ApiError, MATCH_API_ERROR_STATUS, type MatchApiErrorCode } from '../errors'
import { SHIPPED_GAMEMODES } from '../gamemodes'
import type {
  ApiKey,
  ApiKeyCreated,
  ApiKeyCreateRequest,
  Budget,
  BudgetPatchRequest,
  BudgetUsage,
  Capacity,
  ConsoleLine,
  FleetServer,
  GamemodeManifest,
  Match,
  MatchCommand,
  MatchCommandResult,
  MatchEndedReason,
  MatchRequest,
  MatchState,
  Node,
  NodeEnrolment,
  NodeEnrolRequest,
  PlayerToken,
  PlayerTokenRequest,
  ProviderHealth,
  RosterEntry,
  SimStatus,
  WebhookSecretsRequest,
} from '../resources'
import {
  CONSOLE_LINES_MAX,
  gamemodeAllowsMap,
  isTerminalMatchState,
  matchDemoOutcome,
} from '../resources'
import type { StreamCloseCode, StreamFrame } from '../stream/frames'
import { STREAM_CLOSE_CODES } from '../stream/frames'
import type { GameserverEvent, GameserverPlayer } from '../vocabulary/gameserver'
import type { BudgetLimitName, WebhookEnvelope, WebhookPayload } from '../webhooks/envelope'
import { BUDGET_THRESHOLD_FRACTIONS } from '../webhooks/envelope'
import {
  WEBHOOK_ATTEMPT_TIMEOUT_MS,
  webhookAttemptOutcome,
  webhookRetryDelayMs,
} from '../webhooks/retry'
import {
  WEBHOOK_ATTEMPT_HEADER,
  WEBHOOK_CONTENT_TYPE,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  webhookSignedPayload,
} from '../webhooks/signature'
import type {
  WidgetCommandFrame,
  WidgetCommandResultFrame,
  WidgetCommandState,
} from '../widget/socket'
import {
  WIDGET_CLOSE_CODES,
  WIDGET_COMMAND_RATE_LIMIT,
  WIDGET_SOCKET_PROTOCOL,
} from '../widget/socket'
import { hmacSha256HexSync, sha256Hex } from './sha256'
import type {
  FakeFaults,
  FakeOrchestratorOptions,
  FakePlayerCommand,
  FakeSimProviderOptions,
  FakeStreamClose,
  FakeStreamListener,
  FakeStreamSubscription,
  FakeWebhookAttempt,
  FakeWebhookRequest,
  FakeWidgetClose,
  FakeWidgetListener,
  FakeWidgetSession,
} from './types'

// ---------------------------------------------------------------------------
// Constants a test can read
// ---------------------------------------------------------------------------

/** The default seed of the fake's PRNG — every id it mints follows from it. */
export const FAKE_PRNG_SEED = 'ezpug-fake'
/** The name of the root key minted at creation. */
export const FAKE_ADMIN_KEY_NAME = 'fake-admin'
/** Every secret the fake mints starts with one of these — so a fixture scrub can grep for them. */
export const FAKE_SECRET_PREFIXES = Object.freeze({
  apiKey: 'fake-key-',
  playerToken: 'fake-player-token-',
  nodeToken: 'fake-node-token-',
  serverPassword: 'fake-join-',
})
/** The `plugin_event` name the fake's plugin — the simulated server's stand-in mode — answers an applied tap with. */
export const FAKE_PLAYER_COMMAND_EVENT: typeof SIM_PLAYER_COMMAND_EVENT = SIM_PLAYER_COMMAND_EVENT
/** The game port and the GOTV port every simulated server states. */
export const FAKE_SERVER_PORT = 27_015
export const FAKE_TV_PORT = 27_020
/** How long an even-`seq` delivery waits under the out-of-order fault. */
export const FAKE_OUT_OF_ORDER_DELAY_MS = 1_000
/** The status a synthetic webhook failure (the `webhookFailures` fault) reports. */
export const FAKE_SYNTHETIC_FAILURE_STATUS = 503

const SIM_DEFAULTS: Required<FakeSimProviderOptions> = {
  capacity: 8,
  region: 'sim',
  hourlyCents: 0,
  allocateDelayMs: 1_000,
  bootDelayMs: 4_000,
  heartbeatIntervalMs: 10_000,
  positionTickIntervalMs: 5_000,
  readyTimeoutMs: 120_000,
  heartbeatTimeoutMs: 30_000,
  recoveryTimeoutMs: 5 * 60_000,
  autoRecover: true,
  tvDelaySeconds: 90,
}

const FAULT_DEFAULTS: FakeFaults = {
  allocationRefused: false,
  bootNeverEnds: false,
  crash: null,
  webhookDuplicates: false,
  webhookOutOfOrder: false,
  webhookFailures: 0,
  providerDown: false,
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface KeyRecord {
  key: ApiKey
  secret: string
  webhookSecrets: Map<string, string>
  /** `<limit>:<fraction>` thresholds already announced. */
  thresholdsSent: Set<string>
}

interface LedgerRow {
  row: FleetServer
  console: ConsoleLine[]
}

interface StreamSubscriber {
  listener: FakeStreamListener
  onClose: FakeStreamClose | undefined
}

interface MatchRecord {
  match: Match
  request: MatchRequest
  key: KeyRecord
  manifest: GamemodeManifest
  assignment: MatchAssignment
  plan: SimPlan
  envelopes: WebhookEnvelope[]
  commandResults: Map<string, MatchCommandResult>
  server: SimulatedServer | null
  unsubscribe: (() => void) | null
  row: LedgerRow | null
  /** `<serverId>#<seq>` of every server event taken — a chaos duplicate is dropped here. */
  seen: Set<string>
  presence: Map<string, GameserverPlayer>
  /** The roster plus every pushed profile — who the server knows. */
  known: Map<string, RosterEntry>
  /** Players the fake invented to fill an open-join roster; `rostered: false` on their `player.joined`. */
  invented: Set<string>
  timers: Partial<Record<'ttl' | 'allocation' | 'ready' | 'heartbeat' | 'recovery', Timer>>
  subscribers: Set<StreamSubscriber>
  webhooksStopped: boolean
  chain: Promise<void>
  deliveryChain: Promise<void>
  /** The seed the story is told from — handed to a replacement server so it resumes the same match. */
  serverSeed: string | null
  /** Set while a replacement server boots; the round its `going_live` resumes from. */
  restoring: { roundNumber: number } | null
  /** The backups of the lost server, for a `restore` command while `recovering`. */
  recoverable: SimBackup[]
  currentMap: number
  lastSim: SimStatus | null
  /** A `pause` parked the server; the loss detector waits with it. */
  paused: boolean
  /** `demo_available` events seen, and how many of those landed in the client's storage (T21). */
  demos: { announced: number; uploaded: number }
}

interface PlayerTokenRecord {
  matchId: string
  steamId64: string
  expiresAt: number
}

interface NodeRecord {
  node: Node
  token: string
}

export interface CreateMatchResult {
  match: Match
  /** True when the same request was seen before and this is its match, not a new one. */
  replayed: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refuse(code: MatchApiErrorCode, message: string, details?: Record<string, unknown>) {
  return new ApiError(MATCH_API_ERROR_STATUS[code], code, message, details)
}

/** Structural equality on JSON-shaped values — how an idempotent create tells a retry from a conflict. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

function closeCodeFor(error: unknown): StreamCloseCode {
  if (error instanceof ApiError) {
    if (error.code === 'unauthorized') return STREAM_CLOSE_CODES.unauthorized
    if (error.code === 'not_found') return STREAM_CLOSE_CODES.notFound
  }
  return STREAM_CLOSE_CODES.forbidden
}

export { closeCodeFor as streamCloseCodeFor }

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

export function createFakeCore(options: FakeOrchestratorOptions) {
  const { clock } = options
  const prng = options.prng ?? createPrng(FAKE_PRNG_SEED)
  const gamemodes = options.gamemodes ?? SHIPPED_GAMEMODES
  const sim: Required<FakeSimProviderOptions> = { ...SIM_DEFAULTS, ...options.providers?.sim }
  const faults: FakeFaults = { ...FAULT_DEFAULTS, ...options.providers?.faults }
  const fetchImpl = options.fetch ?? globalThis.fetch
  const gsltTotal = options.gsltTotal ?? 0

  const keys = new Map<string, KeyRecord>()
  const keysBySecret = new Map<string, string>()
  const matches = new Map<string, MatchRecord>()
  const matchesByClientId = new Map<string, string>()
  const ledger: LedgerRow[] = []
  const nodes = new Map<string, NodeRecord>()
  const playerTokens = new Map<string, PlayerTokenRecord>()
  const attempts: FakeWebhookAttempt[] = []
  const inflight = new Set<Promise<unknown>>()
  const providerState = { drained: false, downSince: null as string | null }
  let serverCounter = 0
  let providerDownTimer: Timer | undefined

  const now = (): number => clock.now()
  const iso = (): string => clock.date().toISOString()
  const id = (): string => prng.uuid()
  const hex32 = (): string => prng.uuid().replace(/-/g, '')

  const report = (error: unknown, context: Record<string, unknown>): void => {
    if (options.onError) options.onError(error, context)
    else console.error('[fake orchestrator]', context, error)
  }

  /** Track a promise so `settle()` can wait for it. */
  const track = <T>(promise: Promise<T>): Promise<T> => {
    const tracked = promise.finally(() => {
      inflight.delete(tracked)
    })
    inflight.add(tracked)
    return tracked
  }

  /** Run `step` on the match's chain: after everything queued before it, before everything after. */
  const enqueue = <T>(record: MatchRecord, step: () => T | Promise<T>): Promise<T> => {
    const result = record.chain.then(step)
    record.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return track(result)
  }

  // --- Keys -----------------------------------------------------------------

  const mintKey = (request: ApiKeyCreateRequest): ApiKeyCreated => {
    for (const existing of keys.values()) {
      if (existing.key.name === request.name && !existing.key.revokedAt)
        throw refuse('conflict', `a key named ${request.name} exists`)
    }
    const secret = `${FAKE_SECRET_PREFIXES.apiKey}${hex32()}`
    const key: ApiKey = {
      id: id(),
      name: request.name,
      prefix: secret.slice(0, 12),
      scopes: [...request.scopes],
      budget: { ...request.budget },
      webhookSecretIds: request.webhookSecrets.map(s => s.id),
      createdAt: iso(),
      lastUsedAt: null,
      revokedAt: null,
    }
    const record: KeyRecord = {
      key,
      secret,
      webhookSecrets: new Map(request.webhookSecrets.map(s => [s.id, s.secret])),
      thresholdsSent: new Set(),
    }
    keys.set(key.id, record)
    keysBySecret.set(secret, key.id)
    return { key: { ...key }, secret }
  }

  const authenticate = (apiKey: string | null): KeyRecord => {
    const keyId = apiKey ? keysBySecret.get(apiKey) : undefined
    const record = keyId ? keys.get(keyId) : undefined
    if (!record || record.key.revokedAt) throw refuse('unauthorized', 'no such API key')
    record.key.lastUsedAt = iso()
    return record
  }

  const requireKey = (keyId: string): KeyRecord => {
    const record = keys.get(keyId)
    if (!record) throw refuse('not_found', `no key ${keyId}`)
    return record
  }

  const revokeKey = (keyId: string): ApiKey => {
    const record = requireKey(keyId)
    if (!record.key.revokedAt) record.key.revokedAt = iso()
    return { ...record.key }
  }

  const rotateKey = (keyId: string): ApiKeyCreated => {
    const record = requireKey(keyId)
    if (record.key.revokedAt) throw refuse('invalid_state', `key ${keyId} is revoked`)
    keysBySecret.delete(record.secret)
    const secret = `${FAKE_SECRET_PREFIXES.apiKey}${hex32()}`
    record.secret = secret
    record.key.prefix = secret.slice(0, 12)
    keysBySecret.set(secret, record.key.id)
    return { key: { ...record.key }, secret }
  }

  const setKeyBudget = (keyId: string, patch: BudgetPatchRequest): ApiKey => {
    const record = requireKey(keyId)
    record.key.budget = { ...record.key.budget, ...patch }
    // A ceiling that moved is a new crossing: what was announced under the
    // old number says nothing about the new one.
    record.thresholdsSent.clear()
    return { ...record.key }
  }

  const setWebhookSecrets = (keyId: string, body: WebhookSecretsRequest): ApiKey => {
    const record = requireKey(keyId)
    record.webhookSecrets = new Map(body.secrets.map(s => [s.id, s.secret]))
    record.key.webhookSecretIds = body.secrets.map(s => s.id)
    return { ...record.key }
  }

  const admin = mintKey({
    name: FAKE_ADMIN_KEY_NAME,
    scopes: ['admin'],
    budget: { maxConcurrentServers: 1_000, maxServerLifetimeMinutes: 24 * 60, monthlyCents: 0 },
    webhookSecrets: [],
  })

  // --- Money ------------------------------------------------------------------

  const accrued = (row: FleetServer, asOf: number): number => {
    const until = row.releasedAt ? Date.parse(row.releasedAt) : asOf
    const elapsedMs = Math.max(0, until - Date.parse(row.allocatedAt))
    return Math.floor((row.cost.hourlyCents * elapsedMs) / 3_600_000)
  }

  const rowView = (entry: LedgerRow): FleetServer => {
    const at = now()
    return {
      ...entry.row,
      cost: { ...entry.row.cost, accruedCents: accrued(entry.row, at), asOf: iso() },
    }
  }

  const isOpenRow = (row: FleetServer): boolean =>
    row.state !== 'released' && row.state !== 'failed'

  const openRows = (keyId?: string): LedgerRow[] =>
    ledger.filter(e => isOpenRow(e.row) && (keyId === undefined || e.row.keyId === keyId))

  const monthStart = (): string => {
    const date = clock.date()
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString()
  }

  const usageOf = (key: KeyRecord): BudgetUsage => {
    const start = monthStart()
    const at = now()
    let monthCents = 0
    for (const entry of ledger) {
      if (entry.row.keyId !== key.key.id) continue
      if (entry.row.releasedAt && entry.row.releasedAt < start) continue
      monthCents += accrued(entry.row, at)
    }
    return { concurrentServers: openRows(key.key.id).length, monthCents, monthStartedAt: start }
  }

  const budgetOf = (key: KeyRecord): Budget => ({
    keyId: key.key.id,
    limits: { ...key.key.budget },
    usage: usageOf(key),
  })

  const checkBudget = (key: KeyRecord, request: MatchRequest): void => {
    const { budget } = key.key
    const usage = usageOf(key)
    if (usage.concurrentServers + 1 > budget.maxConcurrentServers)
      throw refuse('budget_exceeded', 'the key is at its concurrent-server ceiling', {
        limit: 'maxConcurrentServers',
        ...budget,
        ...usage,
      })
    if (request.ttlMinutes > budget.maxServerLifetimeMinutes)
      throw refuse('budget_exceeded', 'ttlMinutes is above the key’s server lifetime ceiling', {
        limit: 'maxServerLifetimeMinutes',
        ttlMinutes: request.ttlMinutes,
        maxServerLifetimeMinutes: budget.maxServerLifetimeMinutes,
      })
    const projected = Math.ceil((sim.hourlyCents * request.ttlMinutes) / 60)
    if (projected > 0 && usage.monthCents + projected > budget.monthlyCents)
      throw refuse('budget_exceeded', 'the match would cross the key’s monthly ceiling', {
        limit: 'monthlyCents',
        projectedCents: projected,
        ...usage,
        monthlyCents: budget.monthlyCents,
      })
  }

  const announceThresholds = (key: KeyRecord): void => {
    const usage = usageOf(key)
    const { budget } = key.key
    const ratios: [BudgetLimitName, number][] = []
    if (budget.maxConcurrentServers > 0)
      ratios.push(['maxConcurrentServers', usage.concurrentServers / budget.maxConcurrentServers])
    if (budget.monthlyCents > 0)
      ratios.push(['monthlyCents', usage.monthCents / budget.monthlyCents])
    for (const [limit, ratio] of ratios) {
      for (const fraction of BUDGET_THRESHOLD_FRACTIONS) {
        const mark = `${limit}:${fraction}`
        if (ratio < fraction || key.thresholdsSent.has(mark)) continue
        key.thresholdsSent.add(mark)
        for (const record of openMatches(key.key.id)) {
          emit(record, {
            type: 'fleet.budget_threshold',
            limit,
            fraction,
            usage,
            limits: { ...budget },
          })
        }
      }
    }
  }

  // --- The envelope log, the stream, the webhooks -------------------------------

  const openMatches = (keyId?: string): MatchRecord[] =>
    [...matches.values()].filter(
      r => !isTerminalMatchState(r.match.state) && (keyId === undefined || r.key.key.id === keyId),
    )

  const frame = (record: MatchRecord, frame: StreamFrame): void => {
    for (const subscriber of record.subscribers) {
      try {
        subscriber.listener(frame)
      } catch (error) {
        report(error, { matchId: record.match.id, frame: frame.type })
      }
    }
  }

  const closeStreams = (record: MatchRecord, code: StreamCloseCode): void => {
    for (const subscriber of record.subscribers) {
      record.subscribers.delete(subscriber)
      try {
        subscriber.onClose?.(code)
      } catch (error) {
        report(error, { matchId: record.match.id, close: code })
      }
    }
  }

  /** Record one durable fact: the envelope, the stream frame, the webhook. */
  const emit = (record: MatchRecord, payload: WebhookPayload): WebhookEnvelope => {
    const seq = record.envelopes.length + 1
    const envelope: WebhookEnvelope = {
      deliveryId: id(),
      matchId: record.match.id,
      clientMatchId: record.match.clientMatchId,
      seq,
      occurredAt: iso(),
      payload,
    }
    record.envelopes.push(envelope)
    record.match.seq = seq
    record.match.updatedAt = envelope.occurredAt
    frame(record, { type: 'event', envelope })
    scheduleDelivery(record, envelope)
    return envelope
  }

  const scheduleDelivery = (record: MatchRecord, envelope: WebhookEnvelope): void => {
    if (faults.webhookOutOfOrder && envelope.seq % 2 === 0) {
      clock.after(FAKE_OUT_OF_ORDER_DELAY_MS, () => queueAttempt(record, envelope, 1, false))
      return
    }
    queueAttempt(record, envelope, 1, false)
  }

  /** Attempts of one match go out one at a time, in the order they were queued. */
  const queueAttempt = (
    record: MatchRecord,
    envelope: WebhookEnvelope,
    attempt: number,
    duplicate: boolean,
  ): void => {
    const step = record.deliveryChain.then(() =>
      attemptDelivery(record, envelope, attempt, duplicate),
    )
    record.deliveryChain = step.then(
      () => undefined,
      () => undefined,
    )
    void track(step)
  }

  const signatureFor = (record: MatchRecord, body: string): string => {
    const secretId = record.request.callbacks.webhookSecretId
    const secret = record.key.webhookSecrets.get(secretId)
    // The key rotated its secrets under a running match: sign with nothing
    // rather than with a guess. The consumer refuses it and the events route
    // still has the fact.
    if (secret === undefined) return `t=${Math.floor(now() / 1000)},kid=${secretId}`
    const t = Math.floor(now() / 1000)
    const digest = hmacSha256HexSync(secret, webhookSignedPayload(t, body))
    return `t=${t},kid=${secretId},${WEBHOOK_SIGNATURE_VERSION}=${digest}`
  }

  const postWebhook = async (request: FakeWebhookRequest): Promise<number | null> => {
    if (faults.webhookFailures > 0) {
      faults.webhookFailures -= 1
      return FAKE_SYNTHETIC_FAILURE_STATUS
    }
    let timeout: Timer | undefined
    const deadline = new Promise<null>(resolve => {
      timeout = clock.after(WEBHOOK_ATTEMPT_TIMEOUT_MS, () => resolve(null))
    })
    const post = (async (): Promise<number | null> => {
      if (options.webhooks?.deliver) {
        const answer = await options.webhooks.deliver(request)
        if (answer === null) return null
        return typeof answer === 'number' ? answer : answer.status
      }
      if (!fetchImpl) throw new Error('fake orchestrator: no fetch to POST webhooks with')
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
      })
      return response.status
    })()
    try {
      return await Promise.race([post, deadline])
    } catch (error) {
      report(error, { webhook: request.url, deliveryId: request.envelope.deliveryId })
      return null
    } finally {
      timeout?.cancel()
    }
  }

  const attemptDelivery = async (
    record: MatchRecord,
    envelope: WebhookEnvelope,
    attempt: number,
    duplicate: boolean,
  ): Promise<void> => {
    if (record.webhooksStopped) return
    const body = JSON.stringify(envelope)
    const request: FakeWebhookRequest = {
      url: record.request.callbacks.webhookUrl,
      headers: {
        'content-type': WEBHOOK_CONTENT_TYPE,
        [WEBHOOK_SIGNATURE_HEADER]: signatureFor(record, body),
        [WEBHOOK_DELIVERY_HEADER]: envelope.deliveryId,
        [WEBHOOK_ATTEMPT_HEADER]: String(attempt),
      },
      body,
      envelope,
      attempt,
    }
    const status = await postWebhook(request)
    const outcome = webhookAttemptOutcome(status)
    const retryDelay = outcome === 'retry' ? webhookRetryDelayMs(attempt) : null
    attempts.push({
      ...request,
      matchId: envelope.matchId,
      seq: envelope.seq,
      deliveryId: envelope.deliveryId,
      status,
      outcome: outcome === 'retry' && retryDelay === null ? 'given_up' : outcome,
      duplicate,
      at: iso(),
    })
    if (outcome === 'stopped') {
      record.webhooksStopped = true
      return
    }
    if (outcome === 'retry') {
      if (retryDelay !== null)
        clock.after(retryDelay, () => queueAttempt(record, envelope, attempt + 1, false))
      return
    }
    if (faults.webhookDuplicates && !duplicate) queueAttempt(record, envelope, attempt, true)
  }

  // --- Ledger ---------------------------------------------------------------------

  const consoleLine = (record: MatchRecord, line: string): void => {
    const row = record.row
    if (!row) return
    row.console.push({ at: iso(), line })
    if (row.console.length > CONSOLE_LINES_MAX)
      row.console.splice(0, row.console.length - CONSOLE_LINES_MAX)
  }

  const writeRow = (record: MatchRecord): LedgerRow => {
    const at = iso()
    const entry: LedgerRow = {
      row: {
        id: id(),
        provider: SIM_PROVIDER_ID,
        serverId: null,
        node: null,
        matchId: record.match.id,
        keyId: record.key.key.id,
        state: 'allocated',
        game: record.match.game,
        region: sim.region,
        lan: false,
        address: null,
        tv: null,
        cost: { currency: 'EUR', hourlyCents: sim.hourlyCents, accruedCents: 0, asOf: at },
        allocatedAt: at,
        releasedAt: null,
        expiresAt: record.match.expiresAt,
      },
      console: [],
    }
    ledger.push(entry)
    record.row = entry
    record.match.fleetServerId = entry.row.id
    return entry
  }

  const closeRow = (record: MatchRecord, state: 'released' | 'failed'): void => {
    const entry = record.row
    if (!entry) return
    entry.row.state = state
    entry.row.releasedAt = iso()
    entry.row.cost = { ...entry.row.cost, accruedCents: accrued(entry.row, now()), asOf: iso() }
    record.row = null
  }

  // --- Matches: views and lookups ------------------------------------------------

  const view = (record: MatchRecord): Match => ({
    ...record.match,
    connect: record.match.connect ? { ...record.match.connect } : null,
    tv: record.match.tv ? { ...record.match.tv } : null,
    endedReason: record.match.endedReason ? { ...record.match.endedReason } : null,
    sim: record.server?.status().sim ?? record.lastSim,
  })

  const requireMatch = (key: KeyRecord, matchId: string): MatchRecord => {
    const record = matches.get(matchId)
    if (!record || record.key.key.id !== key.key.id)
      throw refuse('not_found', `no match ${matchId}`)
    return record
  }

  const setState = (record: MatchRecord, state: MatchState): void => {
    record.match.state = state
    record.match.updatedAt = iso()
  }

  const cancelTimers = (record: MatchRecord): void => {
    for (const timer of Object.values(record.timers)) timer?.cancel()
    record.timers = {}
  }

  // --- Matches: the door -----------------------------------------------------------

  const inventRoster = (record: {
    request: MatchRequest
    manifest: GamemodeManifest
  }): { teams: MatchRequest['teams']; invented: string[] } => {
    const { request, manifest } = record
    const invented: string[] = []
    const fill = (team: MatchRequest['teams']['teamA'], label: string) => {
      if (team.players.length > 0) return team
      const count = Math.max(
        1,
        Math.min(5, Math.ceil(manifest.slots.teamSize / manifest.slots.teams)),
      )
      const players: RosterEntry[] = []
      for (let i = 0; i < count; i += 1) {
        const steamId64 = `7656119${String(prng.int(0, 1_000_000_000)).padStart(10, '0')}`
        invented.push(steamId64)
        players.push({ steamId64, name: `${label}-${i + 1}`, locale: 'de' })
      }
      return { ...team, players }
    }
    return {
      teams: {
        teamA: fill(request.teams.teamA, 'sim-a'),
        teamB: fill(request.teams.teamB, 'sim-b'),
      },
      invented,
    }
  }

  const planFor = (request: MatchRequest): SimPlan => {
    let scenario = findScenario(request.sim?.scenario ?? 'happy-path')
    if (!scenario)
      throw refuse('validation_failed', `unknown sim scenario ${request.sim?.scenario}`)
    if (faults.bootNeverEnds) scenario = { ...scenario, name: 'never-ready', neverReady: true }
    if (faults.crash)
      scenario = { ...scenario, name: 'server-crash', crashAfterRound: faults.crash.afterRound }
    return {
      scenario,
      ...(request.sim?.seed !== undefined && { seed: request.sim.seed }),
      mode: request.sim?.mode ?? 'auto',
      timeScale: request.sim?.timeScale ?? 1,
      chaos: request.sim?.chaos ?? null,
      bootDelayMs: sim.bootDelayMs,
      heartbeatIntervalMs: sim.heartbeatIntervalMs,
      positionTickIntervalMs: sim.positionTickIntervalMs,
    }
  }

  const createMatch = (key: KeyRecord, request: MatchRequest): CreateMatchResult => {
    const clientKey = `${key.key.id}:${request.clientMatchId}`
    const existingId = matchesByClientId.get(clientKey)
    if (existingId) {
      const existing = matches.get(existingId) as MatchRecord
      if (sameJson(existing.request, request)) return { match: view(existing), replayed: true }
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
    const manifest = gamemodes.find(m => m.id === request.gamemode)
    if (!manifest) throw refuse('unknown_gamemode', `no gamemode ${request.gamemode}`)
    // Decision 18: `csgo` flows through and is refused for want of a provider,
    // before anything about the gamemode is said.
    if (request.game !== 'cs2')
      throw refuse('no_capable_server', `no provider advertises ${request.game}`)
    if (manifest.game !== request.game)
      throw refuse('game_unsupported', `${manifest.id} plays ${manifest.game}, not ${request.game}`)
    for (const plan of request.maps) {
      if (!gamemodeAllowsMap(manifest.maps, plan.map))
        throw refuse('map_not_allowed', `${manifest.id} does not play ${plan.map}`, {
          map: plan.map,
        })
    }
    const plan = planFor(request)
    checkBudget(key, request)
    // Capability: one provider, one region, no LAN.
    if (request.requirements.lan) throw refuse('no_capable_server', 'no LAN node is enrolled')
    if (request.requirements.provider && request.requirements.provider !== SIM_PROVIDER_ID)
      throw refuse('no_capable_server', `no provider ${request.requirements.provider}`)
    if (request.requirements.region && request.requirements.region !== sim.region)
      throw refuse('no_capable_server', `no capacity in ${request.requirements.region}`)
    if (faults.providerDown)
      throw refuse('provider_unavailable', 'the sim provider is not answering')
    if (providerState.drained) throw refuse('no_capable_server', 'the sim provider is drained')
    if (faults.allocationRefused || openRows().length >= sim.capacity)
      throw refuse('no_capable_server', 'the sim provider has no free server')

    const createdAt = iso()
    const matchId = id()
    const record: MatchRecord = {
      match: {
        id: matchId,
        clientMatchId: request.clientMatchId,
        state: 'pending',
        game: request.game,
        gamemode: request.gamemode,
        provider: null,
        serverId: null,
        fleetServerId: null,
        connect: null,
        tv: null,
        seq: 0,
        createdAt,
        updatedAt: createdAt,
        readyAt: null,
        liveAt: null,
        endedAt: null,
        expiresAt: new Date(now() + request.ttlMinutes * 60_000).toISOString(),
        endedReason: null,
        sim: null,
      },
      request,
      key,
      manifest,
      assignment: {
        matchId,
        game: request.game,
        teamA: { name: '', players: [] },
        teamB: { name: '', players: [] },
        maps: [],
        regulationRounds: 0,
        overtime: { enabled: false, maxRounds: 0 },
      },
      plan,
      envelopes: [],
      commandResults: new Map(),
      server: null,
      unsubscribe: null,
      row: null,
      seen: new Set(),
      presence: new Map(),
      known: new Map(),
      invented: new Set(),
      timers: {},
      subscribers: new Set(),
      webhooksStopped: false,
      chain: Promise.resolve(),
      deliveryChain: Promise.resolve(),
      serverSeed: null,
      restoring: null,
      recoverable: [],
      currentMap: 1,
      lastSim: null,
      paused: false,
      demos: { announced: 0, uploaded: 0 },
    }
    // The story needs ten names; an open-join mode arrives with none.
    const { teams, invented } = inventRoster(record)
    for (const steamId64 of invented) record.invented.add(steamId64)
    for (const player of [...teams.teamA.players, ...teams.teamB.players])
      record.known.set(player.steamId64, player)
    record.assignment = assignmentFromMatchRequest({
      matchId,
      game: request.game,
      teams,
      maps: request.maps,
      ...(request.rules && { rules: request.rules }),
      // The engine's stand-in mode enforces the manifest's verbs (T24).
      commands: record.manifest.commands,
      openJoin: record.manifest.slots.openJoin,
    })

    matches.set(matchId, record)
    matchesByClientId.set(clientKey, matchId)
    // The ledger row is written before the provider answers (CLAUDE.md).
    writeRow(record)
    setState(record, 'allocating')
    record.timers.allocation = clock.after(sim.allocateDelayMs, () => {
      void enqueue(record, () => allocated(record))
    })
    record.timers.ttl = clock.at(Date.parse(record.match.expiresAt), () => {
      void enqueue(record, () => expire(record))
    })
    announceThresholds(key)
    return { match: view(record), replayed: false }
  }

  // --- Matches: the machine ---------------------------------------------------------

  const allocated = (record: MatchRecord): void => {
    if (isTerminalMatchState(record.match.state)) return
    const row = record.row as LedgerRow
    const serverId = `sim-${++serverCounter}`
    row.row.serverId = serverId
    row.row.address = { host: `${serverId}.sim.invalid`, port: FAKE_SERVER_PORT }
    row.row.tv = {
      host: `${serverId}.sim.invalid`,
      port: FAKE_TV_PORT,
      delaySeconds: sim.tvDelaySeconds,
    }
    record.match.provider = SIM_PROVIDER_ID
    record.match.serverId = serverId
    emit(record, {
      type: 'match.allocated',
      provider: SIM_PROVIDER_ID,
      serverId,
      fleetServerId: row.row.id,
      region: sim.region,
    })
    bootServer(record, serverId, null)
  }

  const bootServer = (
    record: MatchRecord,
    serverId: string,
    restore: { mapNumber: number; roundNumber: number } | null,
  ): void => {
    const server = createSimulatedServer({
      clock,
      serverId,
      seed: FAKE_PRNG_SEED,
      onError: (error, info) => report(error, { ...info, where: 'sim' }),
    })
    const plan: SimPlan =
      restore && record.serverSeed ? { ...record.plan, seed: record.serverSeed } : record.plan
    server.assign(record.assignment, plan)
    if (restore) server.restore(restore)
    record.server = server
    record.serverSeed = server.status().sim?.seed ?? null
    record.lastSim = null
    record.seen.clear()
    record.unsubscribe = server.events(event => {
      void enqueue(record, () => onServerEvent(record, server, event))
    })
    if (!record.restoring) setState(record, 'configuring')
    if (record.row) record.row.row.state = 'configured'
    consoleLine(
      record,
      `assigned match ${record.match.id} (${record.manifest.id}, ${record.assignment.maps.map(m => m.map).join(', ')})`,
    )
    server.start()
    record.timers.ready = clock.after(sim.readyTimeoutMs, () => {
      void enqueue(record, () => neverReady(record))
    })
  }

  /**
   * The loss detector: no event for `heartbeatTimeoutMs` and the server is
   * declared gone. Armed from `server_ready` on (boot has its own deadline)
   * and suspended while the server is parked — a pause, or step mode, where
   * the story arms no timers and nothing heartbeats on purpose.
   */
  const armHeartbeat = (record: MatchRecord): void => {
    record.timers.heartbeat?.cancel()
    if (record.paused || record.server?.mode() === 'step') return
    record.timers.heartbeat = clock.after(sim.heartbeatTimeoutMs, () => {
      void enqueue(record, () => lost(record))
    })
  }

  const dropServer = (record: MatchRecord, rowState: 'released' | 'failed'): void => {
    if (record.server) {
      record.lastSim = record.server.status().sim
      record.unsubscribe?.()
      record.server.close()
    }
    record.server = null
    record.unsubscribe = null
    record.timers.ready?.cancel()
    record.timers.heartbeat?.cancel()
    closeRow(record, rowState)
  }

  const end = (
    record: MatchRecord,
    state: 'ended' | 'failed' | 'cancelled',
    reason: MatchEndedReason,
    rowState: 'released' | 'failed',
  ): void => {
    if (isTerminalMatchState(record.match.state)) return
    cancelTimers(record)
    dropServer(record, rowState)
    setState(record, state)
    record.match.endedAt = iso()
    record.match.endedReason = reason
    if (state === 'failed') emit(record, { type: 'match.failed', state, reason })
    else
      emit(record, {
        type: 'match.ended',
        state,
        reason,
        demo: matchDemoOutcome({
          recordsDemo: record.manifest.records === 'demo',
          hasUploadUrl: record.request.callbacks.demoUploadUrl !== undefined,
          announced: record.demos.announced,
          uploaded: record.demos.uploaded,
        }),
      })
    closeStreams(record, STREAM_CLOSE_CODES.matchEnded)
  }

  const expire = (record: MatchRecord): void =>
    end(
      record,
      'ended',
      { kind: 'ttl_expired', detail: `ttlMinutes ${record.request.ttlMinutes} ran out` },
      'released',
    )

  const neverReady = (record: MatchRecord): void => {
    if (record.match.readyAt || isTerminalMatchState(record.match.state)) return
    end(
      record,
      'failed',
      { kind: 'provider_error', detail: `no server_ready within ${sim.readyTimeoutMs} ms` },
      'failed',
    )
  }

  const lost = (record: MatchRecord): void => {
    if (isTerminalMatchState(record.match.state) || record.restoring || !record.server) return
    const backups = faults.crash?.backup === false ? [] : record.server.backups()
    const newest = backups.at(-1)
    emit(record, {
      type: 'match.recovering',
      reason: `no heartbeat for ${sim.heartbeatTimeoutMs} ms; the sim provider reports the server gone`,
      backupRound: newest?.roundNumber ?? null,
    })
    setState(record, 'recovering')
    record.recoverable = backups
    consoleLine(record, 'server lost')
    dropServer(record, 'failed')
    if (!newest) {
      end(record, 'failed', { kind: 'server_lost', detail: 'no backup to restore from' }, 'failed')
      return
    }
    if (sim.autoRecover) {
      restoreFrom(record, newest)
      return
    }
    record.timers.recovery = clock.after(sim.recoveryTimeoutMs, () => {
      void enqueue(record, () =>
        end(record, 'failed', { kind: 'server_lost', detail: 'no restore in time' }, 'failed'),
      )
    })
  }

  const restoreFrom = (record: MatchRecord, backup: SimBackup): void => {
    record.timers.recovery?.cancel()
    const row = writeRow(record)
    const serverId = `sim-${++serverCounter}`
    row.row.serverId = serverId
    row.row.address = { host: `${serverId}.sim.invalid`, port: FAKE_SERVER_PORT }
    row.row.tv = {
      host: `${serverId}.sim.invalid`,
      port: FAKE_TV_PORT,
      delaySeconds: sim.tvDelaySeconds,
    }
    record.match.serverId = serverId
    record.match.connect = null
    record.match.tv = null
    record.restoring = { roundNumber: backup.roundNumber }
    emit(record, {
      type: 'match.allocated',
      provider: SIM_PROVIDER_ID,
      serverId,
      fleetServerId: row.row.id,
      region: sim.region,
    })
    bootServer(record, serverId, { mapNumber: backup.mapNumber, roundNumber: backup.roundNumber })
  }

  const presenceFrame = (record: MatchRecord): void =>
    frame(record, { type: 'presence', players: [...record.presence.values()] })

  const onServerEvent = async (
    record: MatchRecord,
    server: SimulatedServer,
    event: GameserverEvent,
  ): Promise<void> => {
    if (record.server !== server || isTerminalMatchState(record.match.state)) return
    if (event.seq !== undefined) {
      const mark = `${event.source.serverId}#${event.seq}`
      if (record.seen.has(mark)) return
      record.seen.add(mark)
    }
    armHeartbeat(record)
    if (event.type === 'position_tick') {
      frame(record, { type: 'tick', ticks: [event] })
      return
    }
    consoleLine(record, describe(event))
    emit(record, event)
    switch (event.type) {
      case 'server_ready': {
        record.timers.ready?.cancel()
        const password = `${FAKE_SECRET_PREFIXES.serverPassword}${hex32().slice(0, 8)}`
        record.match.connect = {
          host: `${server.serverId}.sim.invalid`,
          port: FAKE_SERVER_PORT,
          password,
        }
        record.match.tv = {
          host: `${server.serverId}.sim.invalid`,
          port: FAKE_TV_PORT,
          delaySeconds: sim.tvDelaySeconds,
        }
        record.match.readyAt = iso()
        if (record.row) record.row.row.state = 'running'
        if (!record.restoring) setState(record, 'ready')
        emit(record, {
          type: 'match.server_ready',
          connect: { ...record.match.connect },
          tv: { ...record.match.tv },
          ...(record.restoring && { restored: true, round: record.restoring.roundNumber }),
        })
        break
      }
      case 'player_connected':
        record.presence.set(event.player.steamId64, event.player)
        emit(record, {
          type: 'player.joined',
          player: event.player,
          rostered:
            record.known.has(event.player.steamId64) &&
            !record.invented.has(event.player.steamId64),
        })
        presenceFrame(record)
        break
      case 'player_disconnected':
        record.presence.delete(event.player.steamId64)
        emit(record, { type: 'player.left', player: event.player })
        presenceFrame(record)
        break
      case 'going_live':
        record.currentMap = event.mapNumber
        record.match.liveAt = iso()
        if (record.restoring) {
          emit(record, {
            type: 'match.recovered',
            serverId: server.serverId,
            fleetServerId: (record.row as LedgerRow).row.id,
            resumedFromRound: record.restoring.roundNumber,
          })
          record.restoring = null
        }
        setState(record, 'live')
        break
      case 'demo_available':
        record.demos.announced += 1
        await uploadDemo(record, server, event.mapNumber)
        break
      case 'series_end':
        end(record, 'ended', { kind: 'completed' }, 'released')
        break
      default:
        break
    }
  }

  const describe = (event: GameserverEvent): string => {
    switch (event.type) {
      case 'round_end':
        return `round ${event.roundNumber} ended: ${event.winner.team} (${event.winCondition}) — ${event.score.teamA}:${event.score.teamB}`
      case 'player_connected':
      case 'player_disconnected':
        return `${event.type} ${event.player.name}`
      case 'going_live':
        return `going live on ${event.map}`
      default:
        return event.type
    }
  }

  const uploadDemo = async (
    record: MatchRecord,
    server: SimulatedServer,
    mapNumber: number,
  ): Promise<void> => {
    const url = record.request.callbacks.demoUploadUrl
    if (record.manifest.records !== 'demo' || !url) return
    const recording = server.record(mapNumber)
    if (!recording) {
      report(new Error(`no recording for map ${mapNumber}`), { matchId: record.match.id })
      return
    }
    if (!fetchImpl) {
      report(new Error('no fetch to PUT the demo with'), { matchId: record.match.id })
      return
    }
    try {
      const response = await fetchImpl(url, {
        method: 'PUT',
        headers: { 'content-type': SIMULATED_MATCH_RECORD_CONTENT_TYPE },
        body: recording.bytes as Uint8Array<ArrayBuffer>,
      })
      if (!response.ok) throw new Error(`demo upload answered ${response.status}`)
    } catch (error) {
      report(error, { matchId: record.match.id, demoUploadUrl: url })
      return
    }
    const key = new URL(url).pathname.replace(/^\/+/, '')
    record.demos.uploaded += 1
    emit(record, {
      type: 'demo.uploaded',
      mapNumber,
      ...(key.length > 0 && { key }),
      size: recording.sizeBytes,
      sha256: sha256Hex(recording.bytes),
      contentType: SIMULATED_MATCH_RECORD_CONTENT_TYPE,
    })
  }

  // --- Matches: what a client may do -------------------------------------------------

  const cancelMatch = (key: KeyRecord, matchId: string): Promise<Match> => {
    const record = requireMatch(key, matchId)
    return enqueue(record, () => {
      const { state } = record.match
      if (isTerminalMatchState(state) || state === 'live' || state === 'recovering')
        throw refuse('invalid_state', `cannot cancel a ${state} match; use force_end`)
      end(record, 'cancelled', { kind: 'cancelled' }, 'released')
      return view(record)
    })
  }

  const command = (
    key: KeyRecord,
    matchId: string,
    body: MatchCommand,
  ): Promise<MatchCommandResult> => {
    const record = requireMatch(key, matchId)
    if (body.type === 'rcon' && !key.key.scopes.includes('admin'))
      throw refuse('forbidden', 'rcon needs the admin scope')
    return enqueue(record, async () => {
      const cached = record.commandResults.get(body.correlationId)
      if (cached) return cached
      const result = await applyCommand(record, body)
      record.commandResults.set(body.correlationId, result)
      frame(record, { type: 'command_result', result })
      return result
    })
  }

  const applyCommand = async (
    record: MatchRecord,
    body: MatchCommand,
  ): Promise<MatchCommandResult> => {
    const base = { correlationId: body.correlationId, type: body.type }
    const rejected = (code: MatchApiErrorCode, message: string): MatchCommandResult => ({
      ...base,
      status: 'rejected',
      code,
      message,
    })
    const applied = (extra: Partial<MatchCommandResult> = {}): MatchCommandResult => ({
      ...base,
      status: 'applied',
      ...extra,
    })
    const { state } = record.match
    if (isTerminalMatchState(state)) return rejected('invalid_state', `the match is ${state}`)
    if (body.type === 'restore') {
      if (state !== 'recovering') return rejected('invalid_state', 'restore only while recovering')
      if (record.restoring) return rejected('invalid_state', 'a restore is already in progress')
      const backup =
        body.roundNumber === undefined
          ? record.recoverable.at(-1)
          : record.recoverable.find(b => b.roundNumber === body.roundNumber)
      if (!backup) return rejected('no_backup', 'no backup to restore from')
      restoreFrom(record, backup)
      return applied()
    }
    if (body.type === 'force_end') {
      if (state !== 'ready' && state !== 'live' && state !== 'recovering')
        return rejected('invalid_state', `cannot force_end a ${state} match; cancel it`)
      end(
        record,
        'ended',
        { kind: 'force_ended', ...(body.reason && { detail: body.reason }) },
        'released',
      )
      return applied()
    }
    if (body.type === 'profile') {
      if (!record.manifest.slots.openJoin && !record.known.has(body.player.steamId64))
        return rejected('player_not_in_match', `${body.player.steamId64} is not on the roster`)
      record.known.set(body.player.steamId64, body.player)
      record.invented.delete(body.player.steamId64)
      return applied()
    }
    const server = record.server
    if (!server) return rejected('invalid_state', `no server while ${state}`)
    const source = { provider: SIM_PROVIDER_ID, serverId: server.serverId }
    const status = (): SimStatus => server.status().sim as SimStatus
    switch (body.type) {
      case 'pause':
        if (state !== 'live') return rejected('invalid_state', 'pause only while live')
        server.stop()
        record.paused = true
        record.timers.heartbeat?.cancel()
        emit(record, {
          type: 'match_paused',
          matchId: record.match.id,
          source,
          mapNumber: record.currentMap,
          kind: body.kind ?? 'admin',
        })
        return applied()
      case 'unpause':
        if (state !== 'live') return rejected('invalid_state', 'unpause only while live')
        record.paused = false
        server.start()
        armHeartbeat(record)
        emit(record, {
          type: 'match_unpaused',
          matchId: record.match.id,
          source,
          mapNumber: record.currentMap,
        })
        return applied()
      case 'restart_round':
      case 'reroll':
        return rejected('command_unsupported', 'a simulated server plays a scripted story')
      case 'rcon':
        return rejected('command_unsupported', 'a simulated server has no RCON')
      case 'kick': {
        const player = record.presence.get(body.steamId64)
        if (!player)
          return rejected('player_not_in_match', `${body.steamId64} is not on the server`)
        record.presence.delete(body.steamId64)
        emit(record, { type: 'player_disconnected', matchId: record.match.id, source, player })
        emit(record, { type: 'player.left', player })
        presenceFrame(record)
        return applied()
      }
      case 'announce': {
        const said = await server.announce(body.text)
        return said ? applied() : rejected('invalid_state', 'the server is not playing')
      }
      case 'sim.step': {
        if (server.mode() !== 'step') return rejected('invalid_state', 'sim.step needs step mode')
        const event = await server.step()
        return applied({ stepped: event?.type ?? null, sim: status() })
      }
      case 'sim.mode':
        server.setMode(body.mode)
        armHeartbeat(record)
        return applied({ sim: status() })
      case 'sim.speed':
        server.setSpeed(body.timeScale)
        return applied({ sim: status() })
      case 'sim.chaos':
        server.setChaos(body.chaos)
        return applied({ sim: status() })
      case 'sim.kill':
        server.kill()
        consoleLine(record, 'killed')
        return applied({ sim: status() })
      default:
        return rejected('command_unsupported', `unknown command ${(body as { type: string }).type}`)
    }
  }

  const mintPlayerToken = (
    key: KeyRecord,
    matchId: string,
    body: PlayerTokenRequest,
  ): PlayerToken => {
    const record = requireMatch(key, matchId)
    if (isTerminalMatchState(record.match.state))
      throw refuse('invalid_state', `the match is ${record.match.state}`)
    if (!record.manifest.slots.openJoin && !record.known.has(body.steamId64))
      throw refuse('player_not_in_match', `${body.steamId64} is not on the roster`)
    const token = `${FAKE_SECRET_PREFIXES.playerToken}${hex32()}`
    const expiresAt = now() + body.ttlSeconds * 1000
    playerTokens.set(token, { matchId, steamId64: body.steamId64, expiresAt })
    return {
      token,
      matchId,
      steamId64: body.steamId64,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  const resolvePlayerToken = (token: string): PlayerTokenRecord => {
    const record = playerTokens.get(token)
    if (!record || record.expiresAt <= now()) throw refuse('unauthorized', 'no such player token')
    return record
  }

  /**
   * The widget's tap, as the socket relays it (decision 17): the manifest's
   * verbs, cooldowns and charges are enforced by the simulated server's
   * stand-in mode (`@ezpug/sim`'s command table, the SDK's in TypeScript),
   * which deals the `plugin_event` an applied tap leaves in the log. Refused
   * at this door, before the engine: a match that is not `live`, and a
   * token over its rate limit.
   */
  const runPlayerCommand = async (
    token: PlayerTokenRecord,
    tap: Pick<WidgetCommandFrame, 'command' | 'args'>,
  ): Promise<{
    result: Omit<WidgetCommandResultFrame, 'type' | 'correlationId' | 'command'>
    envelope: WebhookEnvelope | null
  }> => {
    const record = matches.get(token.matchId) as MatchRecord
    const answer = await enqueue(record, async () => {
      if (record.match.state !== 'live' || !record.server)
        return {
          result: {
            status: 'rejected' as const,
            code: 'not_live' as const,
            message: `the match is ${record.match.state}`,
          },
          event: null,
        }
      return await record.server.playerCommand({
        steamId64: token.steamId64,
        command: tap.command,
        ...(tap.args && { args: tap.args }),
      })
    })
    if (!answer.event) return { result: answer.result, envelope: null }
    // The engine dealt the `plugin_event` into this match's queue, right
    // behind the step above; one more turn of the queue and it is an
    // envelope in the log.
    await enqueue(record, () => undefined)
    const dealt = answer.event
    const envelope =
      record.envelopes.find(
        candidate =>
          candidate.payload.type === 'plugin_event' &&
          candidate.payload.seq === dealt.seq &&
          candidate.payload.source.serverId === dealt.source.serverId,
      ) ?? null
    return { result: answer.result, envelope }
  }

  const playerCommand = async (input: FakePlayerCommand): Promise<WebhookEnvelope> => {
    const token = resolvePlayerToken(input.token)
    const record = matches.get(token.matchId) as MatchRecord
    const spec = record.manifest.commands.find(c => c.name === input.command)
    if (!spec)
      throw refuse('command_unsupported', `${record.manifest.id} has no command ${input.command}`)
    const { result, envelope } = await runPlayerCommand(token, input)
    if (result.status === 'applied') {
      if (envelope) return envelope
      throw refuse('internal', 'the tap was applied but its plugin_event was not logged')
    }
    const details = {
      code: result.code,
      ...(result.cooldownMs !== undefined && { cooldownMs: result.cooldownMs }),
      ...(result.chargesLeft !== undefined && { chargesLeft: result.chargesLeft }),
    }
    const message = result.message ?? `the command was ${result.code ?? 'refused'}`
    switch (result.code) {
      case 'not_live':
        throw refuse('invalid_state', message, details)
      case 'invalid_args':
        throw refuse('validation_failed', message, details)
      case 'not_in_match':
        throw refuse('player_not_in_match', message, details)
      case 'rate_limited':
        throw refuse('rate_limited', message, details)
      default:
        throw refuse('invalid_state', message, details)
    }
  }

  /** The bucket behind one token's taps ({@link WIDGET_COMMAND_RATE_LIMIT}). */
  const widgetBuckets = new Map<string, { tokens: number; updatedAt: number }>()
  const takeWidgetTap = (token: string): { ok: true } | { ok: false; retryAfterMs: number } => {
    const { burst, perSecond } = WIDGET_COMMAND_RATE_LIMIT
    const at = now()
    let bucket = widgetBuckets.get(token)
    if (!bucket) {
      bucket = { tokens: burst, updatedAt: at }
      widgetBuckets.set(token, bucket)
    } else {
      bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.updatedAt) / 1000) * perSecond)
      bucket.updatedAt = at
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { ok: true }
    }
    return { ok: false, retryAfterMs: Math.ceil(((1 - bucket.tokens) / perSecond) * 1000) }
  }

  /** The verbs as the widget's `hello` draws them: the manifest's specs with the engine's state for this player. */
  const widgetCommandsOf = (record: MatchRecord, steamId64: string): WidgetCommandState[] => {
    const states = new Map(
      (record.server?.commandStates(steamId64) ?? []).map(state => [state.name, state]),
    )
    return record.manifest.commands.map(spec => {
      const state = states.get(spec.name)
      return {
        ...spec,
        chargesLeft: state ? state.chargesLeft : (spec.charges?.count ?? null),
        readyInMs: state?.readyInMs ?? 0,
      }
    })
  }

  /**
   * The widget socket, in-process (`GET /v1/widget`, decision 17): the
   * token from the hello resolves to a match and a SteamID64; the answer is
   * the `hello` with the mode's verbs; every durable fact of the match
   * follows as an `event` frame; each `command` is answered with a
   * `command_result`. A match that is over gets its hello and the
   * `matchEnded` close at once, like the stream.
   */
  const widget = (
    token: string,
    listener: FakeWidgetListener,
    onClose?: FakeWidgetClose,
  ): FakeWidgetSession => {
    const resolved = resolvePlayerToken(token)
    const record = matches.get(resolved.matchId)
    if (!record) throw refuse('not_found', `no match ${resolved.matchId}`)
    const profile = record.known.get(resolved.steamId64)
    listener({
      type: 'hello',
      protocol: WIDGET_SOCKET_PROTOCOL,
      matchId: record.match.id,
      steamId64: resolved.steamId64,
      gamemode: record.manifest.id,
      state: record.match.state,
      ...(profile && { locale: profile.locale }),
      commands: widgetCommandsOf(record, resolved.steamId64),
    })
    let closed = false
    const subscriber: StreamSubscriber = {
      listener: frame => {
        if (frame.type === 'event') listener({ type: 'event', envelope: frame.envelope })
      },
      onClose: () => {
        if (closed) return
        closed = true
        onClose?.(WIDGET_CLOSE_CODES.matchEnded)
      },
    }
    if (isTerminalMatchState(record.match.state)) {
      subscriber.onClose?.(STREAM_CLOSE_CODES.matchEnded)
      return { command: () => Promise.resolve(), close: () => undefined }
    }
    record.subscribers.add(subscriber)
    return {
      async command(frame) {
        if (closed) return
        const answer = (
          result: Omit<WidgetCommandResultFrame, 'type' | 'correlationId' | 'command'>,
        ): void =>
          listener({
            type: 'command_result',
            correlationId: frame.correlationId,
            command: frame.command,
            ...result,
          })
        if (resolved.expiresAt <= now()) {
          closed = true
          record.subscribers.delete(subscriber)
          onClose?.(WIDGET_CLOSE_CODES.unauthorized)
          return
        }
        const taken = takeWidgetTap(token)
        if (!taken.ok) {
          answer({
            status: 'rejected',
            code: 'rate_limited',
            message: 'too many taps; wait',
            cooldownMs: taken.retryAfterMs,
          })
          return
        }
        const { result } = await runPlayerCommand(resolved, frame)
        if (!closed) answer(result)
      },
      close() {
        closed = true
        record.subscribers.delete(subscriber)
      },
    }
  }

  const events = (key: KeyRecord, matchId: string, afterSeq: number, limit: number) => {
    const record = requireMatch(key, matchId)
    const items = record.envelopes.slice(afterSeq, afterSeq + limit)
    const last = items.at(-1)
    const caughtUp = afterSeq + items.length >= record.envelopes.length
    const nextCursor =
      caughtUp && isTerminalMatchState(record.match.state)
        ? null
        : String(last ? last.seq : afterSeq)
    return { items, nextCursor }
  }

  const stream = (
    subscription: FakeStreamSubscription,
    listener: FakeStreamListener,
    onClose?: FakeStreamClose,
  ): (() => void) => {
    let record: MatchRecord | undefined
    if (subscription.token) {
      const token = resolvePlayerToken(subscription.token)
      if (token.matchId !== subscription.matchId)
        throw refuse('forbidden', 'the player token is for another match')
      record = matches.get(token.matchId)
    } else {
      const key = authenticate(subscription.apiKey ?? null)
      if (!key.key.scopes.includes('admin') && !key.key.scopes.includes('matches'))
        throw refuse('forbidden', 'the key lacks the matches scope')
      record = requireMatch(key, subscription.matchId)
    }
    if (!record) throw refuse('not_found', `no match ${subscription.matchId}`)
    const subscriber: StreamSubscriber = { listener, onClose }
    listener({
      type: 'hello',
      matchId: record.match.id,
      seq: record.match.seq,
      state: record.match.state,
    })
    if (isTerminalMatchState(record.match.state)) {
      onClose?.(STREAM_CLOSE_CODES.matchEnded)
      return () => undefined
    }
    record.subscribers.add(subscriber)
    return () => {
      record?.subscribers.delete(subscriber)
    }
  }

  // --- Fleet ---------------------------------------------------------------------------

  const providerHealth = (): ProviderHealth => ({
    id: SIM_PROVIDER_ID,
    healthy: !faults.providerDown,
    drained: providerState.drained,
    lastCheckedAt: iso(),
    lastError: faults.providerDown ? 'sim: provider down (fault knob)' : null,
    servers: openRows().length,
  })

  const capacity = (): Capacity => ({
    providers: [
      {
        id: SIM_PROVIDER_ID,
        healthy: !faults.providerDown,
        drained: providerState.drained,
        regions: [
          {
            region: sim.region,
            games: ['cs2'],
            lan: false,
            available:
              providerState.drained || faults.providerDown
                ? 0
                : Math.max(0, sim.capacity - openRows().length),
          },
        ],
      },
    ],
    asOf: iso(),
  })

  const requireProvider = (providerId: string): void => {
    if (providerId !== SIM_PROVIDER_ID) throw refuse('not_found', `no provider ${providerId}`)
  }

  const rowByServerId = (serverId: string): LedgerRow => {
    // Newest first: a server id is reused by nobody, but a test may ask about a released one.
    const entry = [...ledger].reverse().find(e => e.row.serverId === serverId)
    if (!entry) throw refuse('not_found', `no server ${serverId}`)
    return entry
  }

  const releaseServer = (serverId: string, reason: string | undefined): Promise<FleetServer> => {
    const entry = rowByServerId(serverId)
    if (!isOpenRow(entry.row))
      throw refuse('invalid_state', `server ${serverId} is ${entry.row.state}`)
    const record = entry.row.matchId ? matches.get(entry.row.matchId) : undefined
    if (!record) {
      entry.row.state = 'released'
      entry.row.releasedAt = iso()
      return Promise.resolve(rowView(entry))
    }
    return enqueue(record, () => {
      end(
        record,
        'failed',
        { kind: 'provider_error', detail: `released by operator${reason ? `: ${reason}` : ''}` },
        'released',
      )
      return rowView(entry)
    })
  }

  const enrolNode = (body: NodeEnrolRequest): NodeEnrolment => {
    if (nodes.has(body.id)) throw refuse('conflict', `node ${body.id} is enrolled`)
    const node: Node = {
      id: body.id,
      labels: { ...body.labels },
      region: body.region,
      version: null,
      connected: false,
      lastSeenAt: null,
      drained: false,
      capacity: { total: 0, inUse: 0, warm: 0 },
      currentMatches: [],
      enrolledAt: iso(),
    }
    const token = `${FAKE_SECRET_PREFIXES.nodeToken}${hex32()}`
    nodes.set(node.id, { node, token })
    return { node: { ...node }, token }
  }

  const requireNode = (nodeId: string): NodeRecord => {
    const record = nodes.get(nodeId)
    if (!record) throw refuse('not_found', `no node ${nodeId}`)
    return record
  }

  // --- Faults ----------------------------------------------------------------------------

  const setFaults = (patch: Partial<FakeFaults>): void => {
    const wasDown = faults.providerDown
    Object.assign(faults, patch)
    if (faults.providerDown && !wasDown) {
      providerState.downSince = iso()
      for (const record of openMatches()) {
        emit(record, {
          type: 'fleet.provider_unreachable',
          provider: SIM_PROVIDER_ID,
          since: providerState.downSince,
          lastError: 'sim: provider down (fault knob)',
        })
      }
    }
    if (!faults.providerDown && wasDown) providerState.downSince = null
  }

  const providerDownFor = (durationMs: number): void => {
    providerDownTimer?.cancel()
    setFaults({ providerDown: true })
    providerDownTimer = clock.after(durationMs, () => setFaults({ providerDown: false }))
  }

  // --- Lifecycle ----------------------------------------------------------------------------

  const settle = async (): Promise<void> => {
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }

  const close = (): void => {
    providerDownTimer?.cancel()
    for (const record of matches.values()) {
      cancelTimers(record)
      record.unsubscribe?.()
      record.server?.close()
      record.subscribers.clear()
    }
  }

  return {
    clock,
    faults: faults as Readonly<FakeFaults>,
    admin,
    gamemodes,
    // keys
    mintKey,
    rotateKey,
    setKeyBudget,
    authenticate,
    listKeys: (): ApiKey[] => [...keys.values()].map(k => ({ ...k.key })),
    revokeKey,
    setWebhookSecrets,
    // matches
    createMatch,
    listMatches: (key: KeyRecord): MatchRecord[] =>
      [...matches.values()].filter(r => r.key.key.id === key.key.id).reverse(),
    requireMatch,
    view,
    cancelMatch,
    command,
    mintPlayerToken,
    playerCommand,
    widget,
    events,
    stream,
    server: (matchId: string): SimulatedServer | null => matches.get(matchId)?.server ?? null,
    // fleet
    capacity,
    providerHealth,
    requireProvider,
    setProviderDrained: (drained: boolean): void => {
      providerState.drained = drained
    },
    ledgerRows: (): FleetServer[] => [...ledger].reverse().map(rowView),
    openServers: (): FleetServer[] => openRows().map(rowView),
    consoleOf: (serverId: string): ConsoleLine[] =>
      rowByServerId(serverId).console.map(l => ({ ...l })),
    releaseServer,
    enrolNode,
    listNodes: (): Node[] => [...nodes.values()].map(n => ({ ...n.node })),
    revokeNode: (nodeId: string): void => {
      requireNode(nodeId)
      nodes.delete(nodeId)
    },
    setNodeDrained: (nodeId: string, drained: boolean): Node => {
      const record = requireNode(nodeId)
      record.node.drained = drained
      return { ...record.node }
    },
    budgetOf,
    gslt: () => ({ total: gsltTotal, inUse: 0 }),
    // webhooks and faults
    deliveries: (matchId?: string): readonly FakeWebhookAttempt[] =>
      matchId === undefined ? [...attempts] : attempts.filter(a => a.matchId === matchId),
    setFaults,
    providerDownFor,
    settle,
    close,
  }
}

export type FakeCore = ReturnType<typeof createFakeCore>
