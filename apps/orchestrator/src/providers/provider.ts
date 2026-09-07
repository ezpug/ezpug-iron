/**
 * **The provider interface** — the platform's `GameServerProvider`
 * (`packages/game/src/provider.ts` on 2026-09-05), ported and grown for the
 * iron (PRD-02 T3). A provider is the *control plane* of a pool of servers:
 * how a server is obtained, told its match, started, probed, stopped and
 * given back. It is never the game itself: events, commands and player
 * commands travel over the one outbound link every server dials (decision
 * 5) — `../link/` is that seam, and the sim provider's in-process servers
 * attach to the same one a real plugin does.
 *
 * What grew since the platform: `rcon` and `console` (the operator fallback
 * for the moment before the link is up, T20), `restore` (a provider that can
 * put a round backup on a server itself, T14), `region`/`lan` on the
 * requirements (decision 23), a price per hour instead of per match (the
 * ledger accrues, decision 7), and the assignment handoff carries the whole
 * request and manifest, because the assignment a plugin loads is composed
 * from both (T6).
 *
 * The reaper contract is part of this interface, not an afterthought
 * (CLAUDE.md "every server is a ledger row"): `deallocate` is **idempotent**
 * — a server that is already gone deallocates successfully — and `list`
 * enumerates provider-side reality so the reaper can hold rows against it.
 */
import type {
  Game,
  GamemodeManifest,
  MatchRequest,
  ServerConnect,
  ServerTv,
  SimStatus,
} from '@ezpug/match-api'

/**
 * Capability labels: what a pool of servers can host. `lan` marks venue
 * hardware — a request with `requirements.lan` considers nothing else, and
 * one without it still prefers a node when it asks for `lan` (decision 23).
 * `region` is a provider's own label (`dusseldorf`, `saarland`, `sim`).
 */
export interface ServerCapabilities {
  games: readonly Game[]
  region: string
  tickrate: number
  lan: boolean
  workshopMaps: boolean
}

/**
 * One thing a provider could allocate right now. A provider with several
 * pools (a node per venue, two Dathost locations) advertises several
 * offerings; selection filters and orders across every provider's.
 */
export interface ServerOffering {
  capabilities: ServerCapabilities
  /** Integer euro cents per server-hour — the ledger's `cost_hourly_cents`. Nodes and the sim cost 0. */
  hourlyCents: number
  /**
   * How many more servers this offering can allocate now. `undefined` means
   * effectively unbounded (cloud); `0` means drained — a disconnected node
   * advertises no capacity rather than disappearing.
   */
  available?: number
}

/** What a match request demands of a server — the selection filter. */
export interface ServerRequirements {
  game: Game
  region?: string
  /** Only venue hardware. */
  lan?: boolean
  /** `true` when a planned map needs a workshop install. */
  workshopMaps?: boolean
}

export interface AllocationRequest {
  /** Providers tag the server with it so `list` can attribute it. */
  matchId: string
  /** The ledger row the server is obtained for — the second tag. */
  fleetServerId: string
  /** The API key that pays; a provider may name the server after it. */
  keyId: string
  requirements: ServerRequirements
  /** The offering that was chosen, so a provider with several pools knows which. */
  offering: ServerOffering
  /** How long the server may live at most; a provider that can set `autostop` does. */
  ttlMinutes: number
}

/**
 * A successful allocation. `connect` travels here where the provider knows it
 * at allocation time (Dathost does, a node by definition); otherwise it
 * arrives with a later `status`. `tv` follows the same rule.
 */
export interface AllocatedServer {
  /** The provider's own handle — the `source.serverId` on every event it emits. */
  serverId: string
  /** Host and port; the join password is the orchestrator's and rides in the configuration. */
  connect?: Omit<ServerConnect, 'password'>
  tv?: ServerTv
  /** The node hosting it, for the node provider. */
  nodeId?: string
  /** Provider-private handle details (a Dathost server's raw id, a container id) — the ledger's `provider_meta`. */
  meta?: Record<string, unknown>
}

/**
 * Everything a server needs to play one match, as the provider hands it on:
 * the request and the manifest the assignment is composed from (T6), the
 * passwords the orchestrator decided, and where the server dials in. The
 * provider delivers this (Dathost's `ezpug.json`, a node's container env,
 * the sim's `assign`); it never interprets it.
 */
export interface ServerConfiguration {
  matchId: string
  game: Game
  request: MatchRequest
  gamemode: GamemodeManifest
  /** The join password (`sv_password`); the match's `connect.password` from `ready` on. */
  joinPassword: string
  /** Where the server's plugin dials the link (decision 5) and the token it presents. */
  link: { url: string; serverToken: string }
}

/** Where a provisioned server is in its life, as the provider sees it. */
export const SERVER_LIFECYCLE_STATES = [
  'allocated',
  'starting',
  'running',
  'stopped',
  'gone',
] as const
export type ServerLifecycleState = (typeof SERVER_LIFECYCLE_STATES)[number]

/**
 * A point-in-time probe. `gone` is a value a failed probe returns rather than
 * an exception it throws; during `live` it opens the recovery window.
 */
export interface ServerStatus {
  state: ServerLifecycleState
  connect?: Omit<ServerConnect, 'password'>
  tv?: ServerTv
  playerCount?: number
}

/** Provider-side reality, one row per existing server — the reaper's raw material. */
export interface ProvisionedServer {
  serverId: string
  /** The match it was allocated for, where the provider kept the tag. */
  matchId?: string
  /** The ledger row it was obtained for, where the provider kept that tag too. */
  fleetServerId?: string
}

/** Where a server's console line came from, for the fleet console route (T20). */
export interface ProviderConsoleLine {
  at: string
  line: string
}

/**
 * One provider adapter. Verbs are promises against the provider's control
 * plane, not the game server. Contract points:
 *
 * - `allocate` rejecting means "try the next candidate" — the provisioning
 *   walk goes on and fails the match only after exhausting the list.
 *   Rejection is expected, never exceptional.
 * - `deallocate` is **idempotent**: a server that is already gone deallocates
 *   successfully. The reaper retries until it holds.
 * - `list` returns provider-side reality *now* — the reconciliation input.
 * - Every optional verb answers `null`/`false` for "I have nothing to do that
 *   on" and throws only when the transport broke.
 */
export interface GameServerProvider {
  /** kebab-case id (`sim`, `dathost`, `nodes`) — the `source.provider` on every event from its servers. */
  readonly id: string
  /** What could be allocated right now. A drained provider returns offerings with no capacity, or none. */
  offerings: () => Promise<ServerOffering[]>
  allocate: (request: AllocationRequest) => Promise<AllocatedServer>
  configure: (serverId: string, configuration: ServerConfiguration) => Promise<void>
  start: (serverId: string) => Promise<void>
  stop: (serverId: string) => Promise<void>
  status: (serverId: string) => Promise<ServerStatus>
  deallocate: (serverId: string) => Promise<void>
  list: () => Promise<ProvisionedServer[]>
  /**
   * **Is the control plane answering?** (T31) A cheap, side-effect-free read
   * the probe loop (`providers/probes.ts`) runs on the clock: Dathost reads
   * the account, a node provider looks at how long ago its nodes were heard
   * from. Throwing is unreachable, and the message becomes the provider's
   * `lastError` on `GET /v1/fleet/providers` — so it says what an operator
   * needs and never a credential.
   *
   * A provider without one is probed through `offerings()`, which is what
   * the sim answers in-process and always truthfully.
   */
  probe?: () => Promise<void>
  /** One line in the server's chat. `false` = no server to say it on. */
  announce?: (serverId: string, line: string) => Promise<boolean>
  /** The operator fallback (decision 5): an RCON command through the control plane. `null` = no RCON here. */
  rcon?: (serverId: string, command: string) => Promise<string | null>
  /** The console backlog the control plane holds, before the link is up. `null` = none. */
  console?: (serverId: string) => Promise<ProviderConsoleLine[] | null>
  /**
   * Put a round backup on the server through the control plane (a file
   * upload), for a provider whose servers cannot take it over the link.
   * `false` = not this provider's way; the link's `assign.restore` is (T14).
   */
  restore?: (
    serverId: string,
    backup: { mapNumber: number; roundNumber: number; filename: string; content: string },
  ) => Promise<boolean>
  /** The `sim` provider's own: what a simulated server reports about itself, for `Match.sim`. */
  sim?: (serverId: string) => SimStatus | null
}

/** True when `offering` can host `requirements` — the one filter selection and tests share. */
export function offeringMatches(
  offering: ServerOffering,
  requirements: ServerRequirements,
): boolean {
  const { capabilities } = offering
  if (!capabilities.games.includes(requirements.game)) return false
  if (requirements.region !== undefined && capabilities.region !== requirements.region) return false
  if (requirements.lan && !capabilities.lan) return false
  if (requirements.workshopMaps && !capabilities.workshopMaps) return false
  if (offering.available !== undefined && offering.available <= 0) return false
  return true
}
