import type { Clock, Prng } from '@ezpug/core'
import type { SimulatedServer } from '@ezpug/sim'
import type { Hono } from 'hono'
import type {
  ApiKeyCreated,
  ApiKeyCreateRequest,
  GamemodeManifest,
  MatchApiRoutes,
  StreamCloseCode,
  StreamFrame,
  Timestamp,
  WebhookEnvelope,
} from '../index'
import type { ApiClient, FlatRoute } from '../rpc'

/**
 * **The fake orchestrator's options.** Everything is injectable and nothing
 * reads the wall clock: the clock decides when a server boots and when a
 * webhook is retried, the PRNG decides every id and password, so two fakes
 * built from the same options play the same match and record the same
 * exchanges (PRD-01 T8's golden files depend on exactly this).
 */
export interface FakeOrchestratorOptions {
  /** The clock every deadline is armed on. A fake clock plays a Bo1 in milliseconds. */
  clock: Clock
  /** Every id, token and password draws from here. Default: seeded `ezpug-fake`. */
  prng?: Prng
  /** The catalog `GET /v1/gamemodes` serves. Default: the four shipped manifests. */
  gamemodes?: readonly GamemodeManifest[]
  providers?: {
    sim?: FakeSimProviderOptions
    /** The fault knobs, as they are at creation; `setFaults` changes them later. */
    faults?: Partial<FakeFaults>
  }
  webhooks?: FakeWebhookOptions
  /**
   * Used for the demo `PUT` to `callbacks.demoUploadUrl` and, when
   * `webhooks.deliver` is not given, for the webhook `POST`s. Default:
   * `globalThis.fetch`. A test injects one and never opens a socket.
   */
  fetch?: typeof globalThis.fetch
  /**
   * How many GSLTs the fake pretends to hold (`GET /v1/fleet/gslt`). A
   * simulated server needs none, so `inUse` stays 0. Default 0.
   */
  gsltTotal?: number
  /**
   * Something went wrong off the request path — a stream listener threw, a
   * demo upload failed, a webhook endpoint threw. Default: `console.error`.
   */
  onError?: (error: unknown, context: Record<string, unknown>) => void
}

/** The `sim` provider as the fake runs it — one region, one game, a price. */
export interface FakeSimProviderOptions {
  /** Servers the provider can run at once. Default 8. */
  capacity?: number
  /** The region badge. Default `sim`. */
  region?: string
  /** What a server costs, so a monthly ceiling can be reached. Default 0. */
  hourlyCents?: number
  /** How long the provider takes to answer an allocation. Default 1 s. */
  allocateDelayMs?: number
  /** How long a server takes from allocation to `server_ready`. Default 4 s. */
  bootDelayMs?: number
  /** The plugin's heartbeat interval. Default 10 s. */
  heartbeatIntervalMs?: number
  /** Position-tick sampling; `null` turns the ephemeral tier off. Default 5 s. */
  positionTickIntervalMs?: number | null
  /** No `server_ready` by then and the match fails `provider_error`. Default 120 s. */
  readyTimeoutMs?: number
  /** No event from the server for this long and it is declared lost. Default 30 s. */
  heartbeatTimeoutMs?: number
  /** A `recovering` match with no restore by then fails `server_lost`. Default 5 min. */
  recoveryTimeoutMs?: number
  /**
   * Restore from the newest backup as soon as a server is lost, the way the
   * orchestrator's recovery flow will. `false` leaves the match `recovering`
   * for a `restore` command. Default true.
   */
  autoRecover?: boolean
  /** The GOTV delay the fake states for every server. Default 90 s. */
  tvDelaySeconds?: number
}

/**
 * **The fault knobs** — the ugly paths the platform's tests and the
 * orchestrator's recovery flow must reproduce on demand. Every knob is
 * deterministic: no dice, just a switch.
 */
export interface FakeFaults {
  /** Every create answers `no_capable_server`, no ledger row is written. */
  allocationRefused: boolean
  /** Servers allocate but never boot; the ready deadline fails the match `provider_error`. */
  bootNeverEnds: boolean
  /**
   * The server dies right after this round's `round_end` on map 1. With
   * `backup: true` the round backups are there to restore from; with
   * `backup: false` they are gone with the box and the match fails `server_lost`.
   */
  crash: { afterRound: number; backup: boolean } | null
  /** Every delivered webhook is POSTed a second time, same `deliveryId`, same attempt header. */
  webhookDuplicates: boolean
  /** Every even `seq` waits a second before its first attempt, so the odd ones overtake it. */
  webhookOutOfOrder: boolean
  /** The next N webhook attempts fail with a synthetic 503 before reaching the endpoint. */
  webhookFailures: number
  /**
   * The provider is unreachable: creates answer `provider_unavailable`,
   * capacity reports it unhealthy, every open match hears
   * `fleet.provider_unreachable`. `providerDownFor(ms)` clears it on the clock.
   */
  providerDown: boolean
}

/** One webhook POST as the fake would put it on the wire. */
export interface FakeWebhookRequest {
  url: string
  headers: Record<string, string>
  body: string
  envelope: WebhookEnvelope
  /** 1-based; a duplicate (the fault) repeats `1`. */
  attempt: number
}

export interface FakeWebhookOptions {
  /**
   * Where deliveries go instead of a `fetch` POST: answer the status the
   * endpoint would (`200` to accept, `500` to be retried, `410` to stop). A
   * thrown error or a returned `null` is a connection failure.
   */
  deliver?: (
    request: FakeWebhookRequest,
  ) => Promise<number | Response | null> | number | Response | null
}

/** What one attempt did, for a test's assertions (`fake.deliveries()`). */
export interface FakeWebhookAttempt extends FakeWebhookRequest {
  matchId: string
  seq: number
  deliveryId: string
  /** The endpoint's status, or null for a timeout, a thrown error or a synthetic failure. */
  status: number | null
  outcome: 'delivered' | 'retry' | 'stopped' | 'given_up'
  /** True for the second POST of a `webhookDuplicates` fault. */
  duplicate: boolean
  at: Timestamp
}

/** How a stream subscriber identifies itself — an API key from a server, a player token from a browser. */
export interface FakeStreamSubscription {
  matchId: string
  apiKey?: string
  token?: string
}

export type FakeStreamListener = (frame: StreamFrame) => void
export type FakeStreamClose = (code: StreamCloseCode) => void

/**
 * A player-scoped command as a gamemode widget would send it over its own
 * socket (decision 17). PRD-02 builds that socket; until then the fake
 * accepts the same thing in-process so the round trip — a tap, the plugin's
 * `plugin_event` — can be proven.
 */
export interface FakePlayerCommand {
  /** A token from `POST /v1/matches/:matchId/player-tokens`. */
  token: string
  /** A command the gamemode's manifest declares. */
  command: string
  args?: Record<string, unknown>
}

/** The typed in-process client: the same surface as the HTTP client, no socket. */
export type FakeMatchApiClient = ApiClient<MatchApiRoutes>

/** The fake mounted over Node HTTP — `listen()`'s handle. */
export interface FakeListener {
  /** `http://127.0.0.1:<port>`, the `baseUrl` a client takes. */
  url: string
  port: number
  close: () => Promise<void>
}

export interface FakeListenOptions {
  /** 0 (the default) lets the OS pick. */
  port?: number
  hostname?: string
}

export interface FakeOrchestrator {
  readonly clock: Clock
  /** The root key, `admin` scope, minted at creation. Its secret is obviously fake. */
  readonly admin: ApiKeyCreated
  /** The Hono app: every route of the table over HTTP. Mount it, or `handler.request()` it in a test. */
  readonly handler: Hono
  /** The typed in-process client for one API key — what a test calls instead of HTTP. */
  client: (apiKey: string) => FakeMatchApiClient
  /** One route, dispatched as the HTTP adapter does it: authenticate, gate, parse, handle, validate. */
  dispatch: (
    route: FlatRoute,
    apiKey: string | null,
    raw: { params?: unknown; query?: unknown; body?: unknown },
  ) => Promise<{ status: number; value: unknown }>
  /** Mint a key without going through `POST /v1/keys` — a test's shortcut. */
  mintKey: (request: ApiKeyCreateRequest) => ApiKeyCreated
  /** Subscribe to a match's stream in-process. The first frame is the `hello`. Throws `ApiError` when refused. */
  stream: (
    subscription: FakeStreamSubscription,
    listener: FakeStreamListener,
    onClose?: FakeStreamClose,
  ) => () => void
  /** A widget's tap, in-process; resolves to the `plugin_event` envelope the fake's plugin answered with. */
  playerCommand: (command: FakePlayerCommand) => Promise<WebhookEnvelope>
  /** Every webhook attempt so far, in the order they were made; for one match when given. */
  deliveries: (matchId?: string) => readonly FakeWebhookAttempt[]
  readonly faults: Readonly<FakeFaults>
  setFaults: (patch: Partial<FakeFaults>) => void
  /** `providerDown` now, cleared after `durationMs` on the clock. */
  providerDownFor: (durationMs: number) => void
  /** The engine handle behind a match, for a test that wants to drive it directly; null before allocation and after release. */
  server: (matchId: string) => SimulatedServer | null
  /** Resolves once every in-flight delivery and upload has finished. Timers armed meanwhile are the clock's to fire. */
  settle: () => Promise<void>
  /**
   * Fake clock only: run every timer and every in-flight promise until the
   * world is quiet — a whole match, its webhooks and their retries.
   */
  playOut: () => Promise<void>
  /** Serve over Node HTTP with the stream as a `ws` upgrade. Close it before the test ends. */
  listen: (options?: FakeListenOptions) => Promise<FakeListener>
  /** Teardown: every server closed, every timer cancelled, every subscriber dropped. */
  close: () => void
}
