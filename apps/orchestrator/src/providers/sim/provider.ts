import type { Clock } from '@ezpug/core'
import { createPrng } from '@ezpug/core'
import type { GameserverPlayer, MatchRequest, RosterEntry, SimStatus } from '@ezpug/match-api'
import type { MatchAssignment, SimPlan, SimulatedServer } from '@ezpug/sim'
import {
  assignmentFromMatchRequest,
  createSimulatedServer,
  findScenario,
  SIM_PROVIDER_ID,
} from '@ezpug/sim'
import type { LinkRegistry, ServerEventSink, ServerRef } from '../../link/channels'
import type {
  AllocatedServer,
  GameServerProvider,
  ProvisionedServer,
  ServerConfiguration,
  ServerOffering,
  ServerStatus,
} from '../provider'
import { createSimChannel } from './channel'

/**
 * **The `sim` provider** (decision 9, PRD-02 T3/T4): `packages/sim`'s engine
 * behind the provider interface. A simulated server is allocated like any
 * other (a handle, an address nobody can connect to, a GOTV relay that does
 * not exist, all `.invalid`), told its match through `configure`, started,
 * probed, stopped and deallocated — and once started it is the server side
 * of the link: its events reach the machine through the same
 * {@link ServerEventSink} a real plugin's do, and commands reach it through
 * a {@link ServerChannel} attached to the same registry. Whoever sits on the
 * other end cannot tell the two apart; if they could, that is a bug here.
 *
 * The story a server tells is decided by one seed per **match**, not per
 * server (`<root>#<matchId>`, or the request's own `sim.seed`): a replacement
 * server for a match that lost its box is handed the dead one's story, which
 * is what makes {@link GameServerProvider.restore} — load a round backup and
 * play on from it — mean anything at all (T14 walks that path; the verb and
 * its determinism are here).
 */

/** The game port and the GOTV port every simulated server states. */
export const SIM_SERVER_PORT = 27_015
export const SIM_TV_PORT = 27_020

export interface SimProviderOptions {
  clock: Clock
  /** Where a started server's events go. */
  sink: ServerEventSink
  /** Where a started server's channel attaches. */
  links: LinkRegistry
  /** Servers the provider can run at once. Default 8. */
  capacity?: number
  /** The region badge. Default `sim`. */
  region?: string
  /** What a server costs per hour, so a monthly ceiling can be reached in a test. Default 0. */
  hourlyCents?: number
  /** The GOTV delay every server states. Default 90. */
  tvDelaySeconds?: number
  /** Per-server defaults under the request's own `sim` block (time scale, mode, boot delay…). */
  defaults?: SimPlan
  /** The determinism root; every story seed derives from it. Default `sim`. */
  seed?: string
  onError?: (error: unknown, context: Record<string, unknown>) => void
}

interface SimServer {
  serverId: string
  matchId: string
  fleetServerId: string
  server: SimulatedServer | null
  configured: boolean
}

/** A real request may carry an empty roster (open join); the story needs names. */
export function inventRoster(
  request: MatchRequest,
  teamSize: number,
  seed: string,
): { teams: MatchRequest['teams']; invented: RosterEntry[] } {
  const prng = createPrng(`${seed}#roster`)
  const invented: RosterEntry[] = []
  const fill = (team: MatchRequest['teams']['teamA'], label: string) => {
    if (team.players.length > 0) return team
    const count = Math.max(1, Math.min(5, teamSize))
    const players: RosterEntry[] = []
    for (let i = 0; i < count; i += 1) {
      const steamId64 = `7656119${String(prng.int(0, 1_000_000_000)).padStart(10, '0')}`
      const player: RosterEntry = { steamId64, name: `${label}-${i + 1}`, locale: 'de' }
      invented.push(player)
      players.push(player)
    }
    return { ...team, players }
  }
  return {
    teams: { teamA: fill(request.teams.teamA, 'sim-a'), teamB: fill(request.teams.teamB, 'sim-b') },
    invented,
  }
}

/** The engine's assignment for a request — rosters invented where the request left them empty. */
export function simAssignmentFor(
  configuration: ServerConfiguration,
  seed: string,
): { assignment: MatchAssignment; invented: RosterEntry[] } {
  const { request, gamemode, matchId, game } = configuration
  const { teams, invented } = inventRoster(
    request,
    Math.ceil(gamemode.slots.teamSize / gamemode.slots.teams),
    seed,
  )
  return {
    assignment: assignmentFromMatchRequest({
      matchId,
      game,
      teams,
      maps: request.maps,
      ...(request.rules && { rules: request.rules }),
    }),
    invented,
  }
}

export class SimPlanError extends Error {
  override readonly name = 'SimPlanError'
}

/** The engine's plan from the request's `sim` block over the provider's defaults. */
export function simPlanFor(request: MatchRequest, defaults: SimPlan = {}): SimPlan {
  const name = request.sim?.scenario
  const scenario = name === undefined ? undefined : findScenario(name)
  if (name !== undefined && !scenario) throw new SimPlanError(`unknown sim scenario ${name}`)
  return {
    ...defaults,
    ...(scenario && { scenario }),
    ...(request.sim?.seed !== undefined && { seed: request.sim.seed }),
    ...(request.sim?.mode !== undefined && { mode: request.sim.mode }),
    ...(request.sim?.timeScale !== undefined && { timeScale: request.sim.timeScale }),
    ...(request.sim?.chaos !== undefined && { chaos: request.sim.chaos }),
  }
}

export interface SimProvider extends GameServerProvider {
  /** The engine handle behind a server, for a test that drives it directly. */
  engine: (serverId: string) => SimulatedServer | null
  /** How many servers exist right now. */
  size: () => number
}

export function createSimProvider(options: SimProviderOptions): SimProvider {
  const { clock, sink, links } = options
  const capacity = options.capacity ?? 8
  const region = options.region ?? 'sim'
  const hourlyCents = options.hourlyCents ?? 0
  const tvDelaySeconds = options.tvDelaySeconds ?? 90
  const root = options.seed ?? 'sim'
  const report =
    options.onError ??
    ((error: unknown, context: Record<string, unknown>) => console.error('[sim]', context, error))
  const servers = new Map<string, SimServer>()
  let counter = 0

  const ref = (serverId: string): ServerRef => ({ provider: SIM_PROVIDER_ID, serverId })
  const host = (serverId: string): string => `${serverId}.sim.invalid`

  const offering = (): ServerOffering => ({
    capabilities: { games: ['cs2'], region, tickrate: 128, lan: false, workshopMaps: true },
    hourlyCents,
    available: Math.max(0, capacity - servers.size),
  })

  const lifecycle = (entry: SimServer): ServerStatus['state'] => {
    if (!entry.server) return 'allocated'
    return entry.server.status().state
  }

  return {
    id: SIM_PROVIDER_ID,

    offerings: () => Promise.resolve([offering()]),

    allocate(request): Promise<AllocatedServer> {
      if (servers.size >= capacity)
        return Promise.reject(new Error(`sim: no free server (${capacity} in use)`))
      counter += 1
      const serverId = `sim-${counter}`
      servers.set(serverId, {
        serverId,
        matchId: request.matchId,
        fleetServerId: request.fleetServerId,
        server: null,
        configured: false,
      })
      return Promise.resolve({
        serverId,
        connect: { host: host(serverId), port: SIM_SERVER_PORT },
        tv: { host: host(serverId), port: SIM_TV_PORT, delaySeconds: tvDelaySeconds },
      })
    },

    configure(serverId, configuration) {
      const entry = servers.get(serverId)
      if (!entry) return Promise.reject(new Error(`sim: no server ${serverId}`))
      if (entry.configured)
        return Promise.reject(new Error(`sim: ${serverId} is already configured`))
      const plan = simPlanFor(configuration.request, options.defaults)
      const seed = plan.seed ?? `${root}#${configuration.matchId}`
      const { assignment } = simAssignmentFor(configuration, seed)
      const server = createSimulatedServer({
        clock,
        serverId,
        seed: root,
        onError: (error, info) => report(error, { ...info, where: 'sim' }),
      })
      server.assign(assignment, { ...plan, seed })
      const presence = new Map<string, GameserverPlayer>()
      let currentMap = 1
      server.events(event => {
        if (event.type === 'player_connected') presence.set(event.player.steamId64, event.player)
        else if (event.type === 'player_disconnected') presence.delete(event.player.steamId64)
        else if (event.type === 'going_live') currentMap = event.mapNumber
        void sink.ingest(ref(serverId), event).catch((error: unknown) => {
          report(error, { serverId, matchId: configuration.matchId, where: 'ingest' })
        })
      })
      entry.server = server
      entry.configured = true
      links.attach(
        createSimChannel({
          server: ref(serverId),
          engine: server,
          matchId: configuration.matchId,
          sink,
          presence,
          currentMap: () => currentMap,
        }),
      )
      return Promise.resolve()
    },

    start(serverId) {
      const entry = servers.get(serverId)
      if (!entry?.server) return Promise.reject(new Error(`sim: ${serverId} is not configured`))
      entry.server.start()
      return Promise.resolve()
    },

    stop(serverId) {
      servers.get(serverId)?.server?.stop()
      return Promise.resolve()
    },

    status(serverId) {
      const entry = servers.get(serverId)
      if (!entry) return Promise.resolve({ state: 'gone' })
      const status = entry.server?.status()
      return Promise.resolve({
        state: lifecycle(entry),
        connect: { host: host(serverId), port: SIM_SERVER_PORT },
        tv: { host: host(serverId), port: SIM_TV_PORT, delaySeconds: tvDelaySeconds },
        ...(status && { playerCount: status.playerCount }),
      })
    },

    deallocate(serverId) {
      const entry = servers.get(serverId)
      if (!entry) return Promise.resolve()
      entry.server?.close()
      links.detach(ref(serverId))
      servers.delete(serverId)
      return Promise.resolve()
    },

    list(): Promise<ProvisionedServer[]> {
      return Promise.resolve(
        [...servers.values()].map(entry => ({
          serverId: entry.serverId,
          matchId: entry.matchId,
          fleetServerId: entry.fleetServerId,
        })),
      )
    },

    announce(serverId, line) {
      const server = servers.get(serverId)?.server
      return server ? server.announce(line) : Promise.resolve(false)
    },

    // A simulated server has no RCON and no console backlog of its own.
    rcon: () => Promise.resolve(null),
    console: () => Promise.resolve(null),

    /**
     * Put a round backup on a configured, not yet started server: the story
     * becomes a boot, the reconnects, `backup_restored` and the match from
     * that round on (T14's recovery, offline). `false` when there is nothing
     * to restore onto; a backup the story never wrote throws
     * (`SimulatorRestoreError`), because asking for a round that does not
     * exist is a bug in the caller, not a provider that cannot oblige.
     */
    restore(serverId, backup) {
      const server = servers.get(serverId)?.server
      if (!server) return Promise.resolve(false)
      server.restore({ mapNumber: backup.mapNumber, roundNumber: backup.roundNumber })
      return Promise.resolve(true)
    },

    sim(serverId): SimStatus | null {
      return servers.get(serverId)?.server?.status().sim ?? null
    },

    engine: serverId => servers.get(serverId)?.server ?? null,
    size: () => servers.size,
  }
}
